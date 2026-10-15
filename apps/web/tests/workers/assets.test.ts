/** Image upload pipeline (design §10.2, ADR 0012). */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiClient, ORIGIN, resetDb } from '../helpers/api-client';
import { pngBytes } from '../helpers/images';

let owner: ApiClient;

beforeEach(async () => {
	await resetDb();
	owner = new ApiClient();
	await owner.setupOwner();
});

function put(client: ApiClient, id: string, body: BodyInit, type = 'image/png') {
	return client.call(`/api/owner/v1/assets/${id}`, {
		method: 'PUT',
		body: body as unknown as string,
		headers: { 'content-type': type }
	});
}

const complete = (client: ApiClient, id: string) =>
	client.json(`/api/owner/v1/assets/${id}/complete`, { body: {} });

describe('upload → complete', () => {
	it('stores in pending, validates, publishes under the content hash, and is idempotent', async () => {
		const id = crypto.randomUUID();
		expect((await put(owner, id, pngBytes())).status).toBe(200);
		expect(await env.PENDING.head(`pending/${id}`)).not.toBeNull();

		const done = await complete(owner, id);
		expect(done.status).toBe(200);
		expect(done.body).toMatchObject({
			id,
			status: 'ready',
			width: 1,
			height: 1,
			mime: 'image/png'
		});
		expect(done.body.url).toMatch(/^\/media\/originals\/[0-9a-f]{64}\.png$/);
		expect(await env.PENDING.head(`pending/${id}`)).toBeNull();
		const key = done.body.url.replace('/media/', '');
		const object = await env.MEDIA.head(key);
		expect(object?.httpMetadata?.contentType).toBe('image/png');
		expect(object?.httpMetadata?.cacheControl).toContain('immutable');

		// Retrying complete (lost response) returns the same result.
		expect((await complete(owner, id)).body).toEqual(done.body);
		// Re-uploading after ready does not change anything.
		expect((await put(owner, id, pngBytes(9))).status).toBe(200);
		expect((await complete(owner, id)).body.url).toBe(done.body.url);
	});

	it('deduplicates identical bytes into one object', async () => {
		const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
		await put(owner, a, pngBytes(3));
		await put(owner, b, pngBytes(3));
		const [ra, rb] = [await complete(owner, a), await complete(owner, b)];
		expect(ra.body.url).toBe(rb.body.url);
		expect(ra.body.id).not.toBe(rb.body.id);
	});

	it('rejects SVG, HEIC, fake image bytes and non-image content types', async () => {
		const svg = new TextEncoder().encode(
			'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
		);
		expect((await put(owner, crypto.randomUUID(), svg, 'image/svg+xml')).status).toBe(415);
		const heic = new Uint8Array([
			0,
			0,
			0,
			0x18,
			...new TextEncoder().encode('ftypheic'),
			0,
			0,
			0,
			0
		]);
		const r = await put(owner, crypto.randomUUID(), heic, 'image/heic');
		expect(r.status).toBe(415);
		expect(((await r.json()) as { message: string }).message).toContain('HEIC');
		const fake = new TextEncoder().encode('this is not a png at all');
		expect((await put(owner, crypto.randomUUID(), fake, 'image/png')).status).toBe(415);
		expect((await put(owner, crypto.randomUUID(), pngBytes(), 'text/html')).status).toBe(415);
	});

	it('rejects bodies over 10 MiB even without a truthful Content-Length', async () => {
		const big = new Uint8Array(10 * 1024 * 1024 + 1);
		big.set(pngBytes());
		const declared = await put(owner, crypto.randomUUID(), big);
		expect(declared.status).toBe(413);
		// Streamed body: the limit is enforced while reading.
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(pngBytes());
				for (let i = 0; i < 11; i++) controller.enqueue(new Uint8Array(1024 * 1024));
				controller.close();
			}
		});
		const res = await owner.api.request(`${ORIGIN}/api/owner/v1/assets/${crypto.randomUUID()}`, {
			method: 'PUT',
			body: stream,
			headers: {
				'content-type': 'image/png',
				origin: ORIGIN,
				'x-csrf-token': owner.csrfToken!,
				cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
			},
			// @ts-expect-error -- required by fetch for streamed request bodies
			duplex: 'half'
		});
		expect(res.status).toBe(413);
	});

	it('requires the owner, CSRF and a UUID id; complete needs an upload', async () => {
		const anon = new ApiClient();
		expect((await put(anon, crypto.randomUUID(), pngBytes())).status).toBe(401);
		expect(
			(
				await owner.call(`/api/owner/v1/assets/${crypto.randomUUID()}`, {
					method: 'PUT',
					body: 'x',
					csrf: false,
					headers: { 'content-type': 'image/png' }
				})
			).status
		).toBe(403);
		expect((await put(owner, '../originals/evil', pngBytes())).status).toBe(404);
		expect((await complete(owner, crypto.randomUUID())).status).toBe(404);
	});
});

describe('rendering data', () => {
	it('exposes ready images (with dimensions) to the page, but never pending ones', async () => {
		const ready = crypto.randomUUID();
		const pending = crypto.randomUUID();
		await put(owner, ready, pngBytes(5));
		await complete(owner, ready);
		await put(owner, pending, pngBytes(6));
		const { getAssets } = await import('../../src/lib/server/assets');
		const assets = await getAssets(env.DB, [ready, pending, crypto.randomUUID()], '/media');
		expect(assets[ready]).toMatchObject({ status: 'ready', width: 1, height: 1 });
		expect(assets[pending]).toMatchObject({ status: 'pending', url: null });
	});
});
