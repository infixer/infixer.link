/**
 * Image assets (design §10, ADR 0012).
 *
 * Upload: the browser PUTs the bytes to the Worker, which enforces the size limit while
 * reading and stores them in the private PENDING bucket. `complete` validates the content,
 * computes SHA-256 and copies the bytes to the public MEDIA bucket under an immutable key
 * (`originals/{sha256}.{ext}`). Nothing in PENDING is ever reachable publicly, and no API
 * accepts an R2 key from the client.
 */
import type { AssetDto } from '@infixer-link/contracts';
import { ApiError } from './http';
import { EXTENSION, IMAGE_LIMITS, REJECT_MESSAGE, sniffImage, type ImageType } from './images';

export interface MediaDeps {
	db: D1Database;
	pending: R2Bucket;
	media: R2Bucket;
	/** "/media" locally, "https://media.infixer.link" in production. */
	mediaBaseUrl: string;
}

interface AssetRow {
	id: string;
	status: 'pending' | 'ready' | 'rejected';
	mime: string | null;
	width: number | null;
	height: number | null;
	object_key: string | null;
	error: string | null;
}

const IMMUTABLE = 'public, max-age=31536000, immutable';

export function mediaUrl(base: string, key: string): string {
	return `${base.replace(/\/$/, '')}/${key}`;
}

function toDto(row: AssetRow, base: string): AssetDto {
	return {
		id: row.id,
		status: row.status,
		url: row.status === 'ready' && row.object_key ? mediaUrl(base, row.object_key) : null,
		width: row.width,
		height: row.height,
		mime: row.mime
	};
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Reads a request body, refusing more than `max` bytes even when Content-Length lies. */
export async function readCapped(
	body: ReadableStream<Uint8Array> | null,
	max: number
): Promise<ArrayBuffer> {
	if (!body) throw new ApiError('bad_request', 'Empty body');
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel().catch(() => {});
			throw new ApiError('payload_too_large', `画像は ${max / 1024 / 1024}MiB までです`);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out.buffer;
}

async function getRow(db: D1Database, id: string) {
	return db
		.prepare('SELECT id, status, mime, width, height, object_key, error FROM assets WHERE id = ?')
		.bind(id)
		.first<AssetRow>();
}

/** Stores uploaded bytes in the private pending area. Re-uploading a pending asset replaces it. */
export async function storePending(
	deps: MediaDeps,
	id: string,
	bytes: ArrayBuffer,
	meta: { name?: string; now: number }
): Promise<AssetDto> {
	const existing = await getRow(deps.db, id);
	if (existing?.status === 'ready') return toDto(existing, deps.mediaBaseUrl);

	const sniff = sniffImage(new Uint8Array(bytes.slice(0, 64 * 1024)));
	if (!sniff.ok && sniff.reason !== 'corrupt' && sniff.reason !== 'too-many-pixels') {
		throw new ApiError('unsupported_media_type', REJECT_MESSAGE[sniff.reason]);
	}
	await deps.pending.put(`pending/${id}`, bytes);
	await deps.db
		.prepare(
			`INSERT INTO assets (id, status, source, bytes, original_name, created_at)
			 VALUES (?, 'pending', 'upload', ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET status = 'pending', bytes = excluded.bytes, error = NULL
			 WHERE assets.status <> 'ready'`
		)
		.bind(id, bytes.byteLength, meta.name?.slice(0, 200) ?? null, meta.now)
		.run();
	return { id, status: 'pending', url: null, width: null, height: null, mime: null };
}

/** Writes validated bytes to MEDIA under their content hash (idempotent). */
async function publishBytes(
	media: R2Bucket,
	bytes: ArrayBuffer,
	type: ImageType
): Promise<{ key: string; sha256: string }> {
	const sha256 = await sha256Hex(bytes);
	const key = `originals/${sha256}.${EXTENSION[type]}`;
	if (!(await media.head(key))) {
		await media.put(key, bytes, { httpMetadata: { contentType: type, cacheControl: IMMUTABLE } });
	}
	return { key, sha256 };
}

/** Validates a pending upload and publishes it. Safe to retry at any point. */
export async function completeAsset(deps: MediaDeps, id: string, now: number): Promise<AssetDto> {
	const row = await getRow(deps.db, id);
	if (!row) throw new ApiError('not_found', 'Upload not found');
	if (row.status === 'ready') return toDto(row, deps.mediaBaseUrl);

	const object = await deps.pending.get(`pending/${id}`);
	if (!object) throw new ApiError('not_found', 'Upload data not found; upload again');
	const bytes = await object.arrayBuffer();
	const sniff = bytes.byteLength > IMAGE_LIMITS.maxBytes ? null : sniffImage(new Uint8Array(bytes));
	if (!sniff || !sniff.ok) {
		const message = sniff ? REJECT_MESSAGE[sniff.reason] : '画像が大きすぎます';
		await deps.db
			.prepare(`UPDATE assets SET status = 'rejected', error = ? WHERE id = ?`)
			.bind(message, id)
			.run();
		await deps.pending.delete(`pending/${id}`);
		throw new ApiError('validation_failed', message);
	}

	const { key, sha256 } = await publishBytes(deps.media, bytes, sniff.type);
	await deps.db
		.prepare(
			`UPDATE assets SET status = 'ready', mime = ?, bytes = ?, width = ?, height = ?, sha256 = ?,
			   object_key = ?, published_at = ?, error = NULL
			 WHERE id = ? AND status <> 'ready'`
		)
		.bind(sniff.type, bytes.byteLength, sniff.width, sniff.height, sha256, key, now, id)
		.run();
	await deps.pending.delete(`pending/${id}`);
	return toDto((await getRow(deps.db, id))!, deps.mediaBaseUrl);
}

export async function getAssets(
	db: D1Database,
	ids: string[],
	mediaBaseUrl: string
): Promise<Record<string, AssetDto>> {
	if (ids.length === 0) return {};
	const { results } = await db
		.prepare(
			`SELECT id, status, mime, width, height, object_key, error FROM assets
			 WHERE id IN (SELECT value FROM json_each(?))`
		)
		.bind(JSON.stringify(ids.slice(0, 200)))
		.all<AssetRow>();
	return Object.fromEntries(results.map((r) => [r.id, toDto(r, mediaBaseUrl)]));
}

/** Stores an already-downloaded image (link-card thumbnails) as a ready asset. */
export async function storeRemoteImage(
	deps: Pick<MediaDeps, 'db' | 'media'>,
	bytes: ArrayBuffer,
	now: number
): Promise<string | null> {
	if (bytes.byteLength > IMAGE_LIMITS.maxPreviewBytes) return null;
	const sniff = sniffImage(new Uint8Array(bytes));
	if (!sniff.ok) return null;
	const { key, sha256 } = await publishBytes(deps.media, bytes, sniff.type);
	const reuse = await deps.db
		.prepare(
			`SELECT id FROM assets WHERE sha256 = ? AND source = 'link-preview' AND status = 'ready' LIMIT 1`
		)
		.bind(sha256)
		.first<{ id: string }>();
	if (reuse) return reuse.id;
	const id = crypto.randomUUID();
	await deps.db
		.prepare(
			`INSERT INTO assets (id, status, source, mime, bytes, width, height, sha256, object_key, created_at, published_at)
			 VALUES (?, 'ready', 'link-preview', ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(id, sniff.type, bytes.byteLength, sniff.width, sniff.height, sha256, key, now, now)
		.run();
	return id;
}
