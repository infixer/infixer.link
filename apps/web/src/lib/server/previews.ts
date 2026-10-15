/**
 * Link card metadata (ADR 0010).
 *
 * - Fetched only when the owner asks (editor), never on public page views.
 * - Only http(s) on default ports; private / local hosts are refused (unless explicitly
 *   allowed for local development); redirects are followed manually and re-checked.
 * - At most 512 KiB of HTML is read, with a 5 s timeout; only <head> metadata is kept.
 */
import type { LinkPreviewDto } from '@infixer-link/contracts';

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_ERROR_MS = 24 * 60 * 60 * 1000;
const USER_AGENT = 'infixer.link link preview (+https://infixer.link)';

interface PreviewRow {
	url: string;
	status: 'ok' | 'error';
	title: string | null;
	description: string | null;
	site_name: string | null;
	fetched_at: number;
}

function toDto(row: PreviewRow): LinkPreviewDto {
	return {
		url: row.url,
		ok: row.status === 'ok',
		title: row.title,
		description: row.description,
		siteName: row.site_name,
		host: new URL(row.url).hostname
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

/** Reads at most MAX_BYTES of the body. */
async function readLimited(res: Response): Promise<string> {
	const reader = res.body?.getReader();
	if (!reader) return '';
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (total < MAX_BYTES) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		total += value.byteLength;
	}
	await reader.cancel().catch(() => {});
	const buf = new Uint8Array(Math.min(total, MAX_BYTES));
	let offset = 0;
	for (const chunk of chunks) {
		const part = chunk.subarray(0, buf.length - offset);
		buf.set(part, offset);
		offset += part.length;
		if (offset >= buf.length) break;
	}
	return new TextDecoder().decode(buf);
}

/** Extracts OGP / Twitter / <title> / description from the head of an HTML document. */
export function extractMeta(html: string): {
	title?: string;
	description?: string;
	siteName?: string;
	image?: string;
} {
	const head = html.slice(
		0,
		html.search(/<\/head>/i) === -1 ? html.length : html.search(/<\/head>/i)
	);
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

export async function fetchPreview(
	rawUrl: string,
	options: { fetcher: Fetcher; allowLocal: boolean }
): Promise<
	Omit<PreviewRow, 'fetched_at'> & { image_url: string | null; final_url: string | null }
> {
	const failed = {
		url: rawUrl,
		status: 'error' as const,
		title: null,
		description: null,
		site_name: null,
		image_url: null,
		final_url: null
	};
	let url = checkFetchable(rawUrl, options.allowLocal);
	if (!url) return failed;

	try {
		const signal = AbortSignal.timeout(TIMEOUT_MS);
		let res: Response | null = null;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			res = await options.fetcher(url.toString(), {
				redirect: 'manual',
				signal,
				headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' }
			});
			if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
				await res.body?.cancel();
				const next = checkFetchable(
					new URL(res.headers.get('location')!, url).toString(),
					options.allowLocal
				);
				if (!next) return failed;
				url = next;
				res = null;
				continue;
			}
			break;
		}
		if (!res || !res.ok) return failed;
		const type = res.headers.get('content-type') ?? '';
		if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
			await res.body?.cancel();
			return { ...failed, status: 'ok', title: null, final_url: url.toString() };
		}
		const meta = extractMeta(await readLimited(res));
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

/** Public read path: cached previews only. */
export async function getPreviews(
	db: D1Database,
	urls: string[]
): Promise<Record<string, LinkPreviewDto>> {
	if (urls.length === 0) return {};
	const { results } = await db
		.prepare(
			`SELECT url, status, title, description, site_name, fetched_at FROM link_previews
			 WHERE url IN (SELECT value FROM json_each(?))`
		)
		.bind(JSON.stringify(urls.slice(0, 200)))
		.all<PreviewRow>();
	return Object.fromEntries(results.map((r) => [r.url, toDto(r)]));
}

/** Owner path: fetches missing or stale previews (up to 20 URLs, 4 at a time). */
export async function refreshPreviews(
	db: D1Database,
	urls: string[],
	options: { fetcher: Fetcher; allowLocal: boolean; now: number }
): Promise<Record<string, LinkPreviewDto>> {
	const unique = [...new Set(urls)].slice(0, 20);
	const cached = await db
		.prepare(
			`SELECT url, status, title, description, site_name, fetched_at FROM link_previews
			 WHERE url IN (SELECT value FROM json_each(?))`
		)
		.bind(JSON.stringify(unique))
		.all<PreviewRow>();
	const byUrl = new Map(cached.results.map((r) => [r.url, r]));
	const stale = unique.filter((u) => {
		const row = byUrl.get(u);
		if (!row) return true;
		const age = options.now - row.fetched_at;
		return row.status === 'ok' ? age > FRESH_MS : age > RETRY_ERROR_MS;
	});

	for (let i = 0; i < stale.length; i += 4) {
		const fetched = await Promise.all(stale.slice(i, i + 4).map((u) => fetchPreview(u, options)));
		await db.batch(
			fetched.map((p) =>
				db
					.prepare(
						`INSERT INTO link_previews (url, status, title, description, site_name, image_url, final_url, fetched_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
						 ON CONFLICT (url) DO UPDATE SET status = excluded.status, title = excluded.title,
						   description = excluded.description, site_name = excluded.site_name,
						   image_url = excluded.image_url, final_url = excluded.final_url, fetched_at = excluded.fetched_at`
					)
					.bind(
						p.url,
						p.status,
						p.title,
						p.description,
						p.site_name,
						p.image_url,
						p.final_url,
						options.now
					)
			)
		);
		for (const p of fetched) byUrl.set(p.url, { ...p, fetched_at: options.now });
	}
	return Object.fromEntries(
		unique.filter((u) => byUrl.has(u)).map((u) => [u, toDto(byUrl.get(u)!)])
	);
}
