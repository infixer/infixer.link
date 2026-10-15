/**
 * Link card metadata (ADR 0010).
 *
 * - Fetched only when the owner asks (editor), never on public page views.
 * - Only http(s) on default ports; private / local hosts are refused (unless explicitly
 *   allowed for local development); redirects are followed manually and re-checked.
 * - At most 512 KiB of HTML is read, with a 5 s timeout; only <head> metadata is kept.
 * - The og:image is copied into R2 (≤ 5 MiB, validated) and never hotlinked (ADR 0012).
 * - YouTube (ADR 0014): title from oEmbed, thumbnail from i.ytimg.com (also copied into R2).
 *   The video id comes from the URL, so the player works even if both requests fail.
 */
import type { LinkPreviewDto } from '@infixer-link/contracts';
import {
	youtubeThumbnailUrl,
	youtubeVideo,
	youtubeWatchUrl,
	type Video
} from '@infixer-link/content';
import { mediaUrl, storeRemoteImage } from './assets';
import { IMAGE_LIMITS } from './images';

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

const MAX_HTML_BYTES = 512 * 1024;
const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_ERROR_MS = 24 * 60 * 60 * 1000;
const USER_AGENT = 'infixer.link link preview (+https://infixer.link)';
const MAX_OEMBED_BYTES = 64 * 1024;
/** Failed YouTube lookups are retried sooner: the player itself does not depend on them. */
const RETRY_VIDEO_ERROR_MS = 10 * 60 * 1000;

interface PreviewRow {
	url: string;
	status: 'ok' | 'error';
	title: string | null;
	description: string | null;
	site_name: string | null;
	fetched_at: number;
	image_key: string | null;
	image_width: number | null;
	image_height: number | null;
}

const SELECT_PREVIEWS = `SELECT p.url, p.status, p.title, p.description, p.site_name, p.fetched_at,
	   a.object_key AS image_key, a.width AS image_width, a.height AS image_height
	 FROM link_previews p LEFT JOIN assets a ON a.id = p.image_asset_id AND a.status = 'ready'
	 WHERE p.url IN (SELECT value FROM json_each(?))`;

function toDto(row: PreviewRow, mediaBaseUrl: string): LinkPreviewDto {
	return {
		url: row.url,
		ok: row.status === 'ok',
		title: row.title,
		description: row.description,
		siteName: row.site_name,
		host: new URL(row.url).hostname,
		image:
			row.image_key && row.image_width && row.image_height
				? {
						url: mediaUrl(mediaBaseUrl, row.image_key),
						width: row.image_width,
						height: row.image_height
					}
				: null
	};
}

/** Private, loopback, link-local and other non-public hosts. */
export function isForbiddenHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host.endsWith('.local') ||
		host.endsWith('.internal')
	) {
		return true;
	}
	if (!host.includes('.') && !host.includes(':')) return true; // single-label names
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			a >= 224
		);
	}
	if (host.includes(':')) {
		return (
			host === '::1' ||
			host === '::' ||
			/^(fc|fd|fe8|fe9|fea|feb)/.test(host) ||
			host.startsWith('::ffff:')
		);
	}
	return false;
}

export function checkFetchable(raw: string, allowLocal: boolean): URL | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	if (url.username || url.password) return null;
	if (
		url.port &&
		url.port !== '80' &&
		url.port !== '443' &&
		!(allowLocal && url.hostname === 'localhost')
	) {
		return null;
	}
	if (!allowLocal && isForbiddenHost(url.hostname)) return null;
	return url;
}

function clean(value: string | undefined | null, max: number): string | null {
	if (!value) return null;
	const text = value
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/\s+/g, ' ')
		.trim();
	if (!text) return null;
	return [...text].length > max ? [...text].slice(0, max - 1).join('') + '…' : text;
}

/**
 * Reads at most `max` bytes. With `strict`, a longer body is a failure (null);
 * otherwise it is truncated (HTML: only the head matters).
 */
async function readBytes(res: Response, max: number, strict: boolean): Promise<Uint8Array | null> {
	const reader = res.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (total + value.byteLength > max) {
			await reader.cancel().catch(() => {});
			if (strict) return null;
			chunks.push(value.subarray(0, max - total));
			total = max;
			break;
		}
		chunks.push(value);
		total += value.byteLength;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/** GET with manual, re-checked redirects. */
async function safeGet(
	rawUrl: string,
	accept: string,
	options: { fetcher: Fetcher; allowLocal: boolean }
): Promise<{ res: Response; url: URL } | null> {
	let url = checkFetchable(rawUrl, options.allowLocal);
	if (!url) return null;
	const signal = AbortSignal.timeout(TIMEOUT_MS);
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const res = await options.fetcher(url.toString(), {
			redirect: 'manual',
			signal,
			headers: { 'user-agent': USER_AGENT, accept }
		});
		if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
			await res.body?.cancel();
			url = checkFetchable(
				new URL(res.headers.get('location')!, url).toString(),
				options.allowLocal
			);
			if (!url) return null;
			continue;
		}
		return { res, url };
	}
	return null;
}

/** Extracts OGP / Twitter / <title> / description from the head of an HTML document. */
export function extractMeta(html: string): {
	title?: string;
	description?: string;
	siteName?: string;
	image?: string;
} {
	const end = html.search(/<\/head>/i);
	const head = html.slice(0, end === -1 ? html.length : end);
	const meta: Record<string, string> = {};
	for (const tag of head.matchAll(/<meta\b[^>]*>/gi)) {
		const attrs: Record<string, string> = {};
		for (const a of tag[0].matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
			attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? a[5] ?? '';
		}
		const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
		if (key && attrs.content !== undefined && !(key in meta)) meta[key] = attrs.content;
	}
	const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
	return {
		title: meta['og:title'] ?? meta['twitter:title'] ?? title,
		description: meta['og:description'] ?? meta['twitter:description'] ?? meta['description'],
		siteName: meta['og:site_name'],
		image: meta['og:image'] ?? meta['twitter:image']
	};
}

export interface FetchedPreview {
	url: string;
	status: 'ok' | 'error';
	title: string | null;
	description: string | null;
	site_name: string | null;
	image_url: string | null;
	final_url: string | null;
}

/** YouTube: oEmbed for the title / channel; the thumbnail URL is derived from the id. */
async function fetchVideoPreview(
	rawUrl: string,
	video: Video,
	options: { fetcher: Fetcher; allowLocal: boolean }
): Promise<FetchedPreview> {
	const base: FetchedPreview = {
		url: rawUrl,
		status: 'error',
		title: null,
		description: null,
		site_name: 'YouTube',
		image_url: youtubeThumbnailUrl(video),
		final_url: youtubeWatchUrl(video)
	};
	try {
		const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(youtubeWatchUrl(video))}`;
		const got = await safeGet(endpoint, 'application/json', options);
		if (!got || !got.res.ok) {
			await got?.res.body?.cancel();
			return base;
		}
		const body = await readBytes(got.res, MAX_OEMBED_BYTES, true);
		const json = JSON.parse(new TextDecoder().decode(body ?? new Uint8Array())) as {
			title?: unknown;
			author_name?: unknown;
		};
		const text = (v: unknown, max: number) => (typeof v === 'string' ? clean(v, max) : null);
		return {
			...base,
			status: 'ok',
			title: text(json.title, 300),
			description: text(json.author_name, 200)
		};
	} catch {
		return base;
	}
}

export async function fetchPreview(
	rawUrl: string,
	options: { fetcher: Fetcher; allowLocal: boolean }
): Promise<FetchedPreview> {
	const video = youtubeVideo(rawUrl);
	if (video) return fetchVideoPreview(rawUrl, video, options);
	const failed: FetchedPreview = {
		url: rawUrl,
		status: 'error',
		title: null,
		description: null,
		site_name: null,
		image_url: null,
		final_url: null
	};
	try {
		const got = await safeGet(rawUrl, 'text/html,application/xhtml+xml', options);
		if (!got || !got.res.ok) {
			await got?.res.body?.cancel();
			return failed;
		}
		const { res, url } = got;
		const type = res.headers.get('content-type') ?? '';
		if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
			await res.body?.cancel();
			return { ...failed, status: 'ok', final_url: url.toString() };
		}
		const body = await readBytes(res, MAX_HTML_BYTES, false);
		const meta = extractMeta(new TextDecoder().decode(body ?? new Uint8Array()));
		let image: string | null = null;
		if (meta.image) {
			try {
				const resolved = new URL(meta.image, url);
				if (resolved.protocol === 'https:' || resolved.protocol === 'http:')
					image = resolved.toString();
			} catch {
				// ignore malformed image URLs
			}
		}
		return {
			url: rawUrl,
			status: 'ok',
			title: clean(meta.title, 300),
			description: clean(meta.description, 500),
			site_name: clean(meta.siteName, 100),
			image_url: image,
			final_url: url.toString()
		};
	} catch {
		return failed;
	}
}

/** Downloads a card image with the same safety rules (≤ 5 MiB, image/* only). */
export async function fetchImage(
	rawUrl: string,
	options: { fetcher: Fetcher; allowLocal: boolean }
): Promise<ArrayBuffer | null> {
	try {
		const got = await safeGet(rawUrl, 'image/*', options);
		if (!got) return null;
		const { res } = got;
		const declared = Number(res.headers.get('content-length') ?? 0);
		if (
			!res.ok ||
			!/^image\//i.test(res.headers.get('content-type') ?? '') ||
			declared > IMAGE_LIMITS.maxPreviewBytes
		) {
			await res.body?.cancel();
			return null;
		}
		const bytes = await readBytes(res, IMAGE_LIMITS.maxPreviewBytes, true);
		return bytes
			? (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
			: null;
	} catch {
		return null;
	}
}

/** Public read path: cached previews only. */
export async function getPreviews(
	db: D1Database,
	urls: string[],
	mediaBaseUrl: string
): Promise<Record<string, LinkPreviewDto>> {
	if (urls.length === 0) return {};
	const { results } = await db
		.prepare(SELECT_PREVIEWS)
		.bind(JSON.stringify(urls.slice(0, 200)))
		.all<PreviewRow>();
	return Object.fromEntries(results.map((r) => [r.url, toDto(r, mediaBaseUrl)]));
}

/** Owner path: fetches missing or stale previews (up to 20 URLs, 4 at a time). */
export async function refreshPreviews(
	db: D1Database,
	urls: string[],
	options: {
		fetcher: Fetcher;
		allowLocal: boolean;
		now: number;
		/** When given, card images are copied into R2 (ADR 0012). */
		media?: { bucket: R2Bucket; baseUrl: string };
	}
): Promise<Record<string, LinkPreviewDto>> {
	const unique = [...new Set(urls)].slice(0, 20);
	const cached = await db.prepare(SELECT_PREVIEWS).bind(JSON.stringify(unique)).all<PreviewRow>();
	const byUrl = new Map(cached.results.map((r) => [r.url, r]));
	const stale = unique.filter((u) => {
		const row = byUrl.get(u);
		if (!row) return true;
		const age = options.now - row.fetched_at;
		if (row.status === 'ok') return age > FRESH_MS;
		return age > (youtubeVideo(u) ? RETRY_VIDEO_ERROR_MS : RETRY_ERROR_MS);
	});

	for (let i = 0; i < stale.length; i += 4) {
		const fetched = await Promise.all(
			stale.slice(i, i + 4).map(async (u) => {
				const p = await fetchPreview(u, options);
				let imageAssetId: string | null = null;
				if (p.image_url && options.media) {
					const bytes = await fetchImage(p.image_url, options);
					if (bytes) {
						imageAssetId = await storeRemoteImage(
							{ db, media: options.media.bucket },
							bytes,
							options.now
						).catch(() => null);
					}
				}
				return { ...p, imageAssetId };
			})
		);
		await db.batch(
			fetched.map((p) =>
				db
					.prepare(
						`INSERT INTO link_previews (url, status, title, description, site_name, image_url,
						   final_url, image_asset_id, fetched_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
						 ON CONFLICT (url) DO UPDATE SET status = excluded.status, title = excluded.title,
						   description = excluded.description, site_name = excluded.site_name,
						   image_url = excluded.image_url, final_url = excluded.final_url,
						   image_asset_id = excluded.image_asset_id, fetched_at = excluded.fetched_at`
					)
					.bind(
						p.url,
						p.status,
						p.title,
						p.description,
						p.site_name,
						p.image_url,
						p.final_url,
						p.imageAssetId,
						options.now
					)
			)
		);
	}
	// Re-read so image URLs and dimensions come from the assets table.
	const fresh = await db.prepare(SELECT_PREVIEWS).bind(JSON.stringify(unique)).all<PreviewRow>();
	return Object.fromEntries(
		fresh.results.map((r) => [r.url, toDto(r, options.media?.baseUrl ?? '')])
	);
}
