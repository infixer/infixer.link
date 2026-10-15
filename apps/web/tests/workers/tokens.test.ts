/** CLI tokens, Bearer access, scopes and export (design §9.6, §13, ADR 0016). */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '../../src/lib/server/api/app';
import { ApiClient, Clock, config, newPage, resetDb } from '../helpers/api-client';
import type { SoftAuthenticator } from '../helpers/soft-authenticator';

let clock: Clock;
let owner: ApiClient;
let key: SoftAuthenticator;

const api = () =>
	createApi({
		db: env.DB,
		config,
		now: clock.now,
		pending: env.PENDING,
		media: env.MEDIA,
		mediaBaseUrl: '/media',
		timeZone: 'Asia/Tokyo'
	});

/** A CLI: no cookies, no Origin, no CSRF — only the Bearer token. */
function cli(token: string) {
	const client = new ApiClient(api());
	const call = client.call.bind(client);
	client.call = (path, options = {}) =>
		call(path, {
			...options,
			origin: null,
			csrf: false,
			headers: { ...options.headers, authorization: `Bearer ${token}` }
		});
	return client;
}

async function issue(scopes: string[], extra: Record<string, unknown> = {}) {
	const res = await owner.json('/api/owner/v1/tokens', {
		body: { label: 'ノート PC', scopes, ...extra }
	});
	expect(res.status).toBe(201);
	return res.body as { id: string; token: string; scopes: string[]; expiresAt: string };
}

beforeEach(async () => {
	await resetDb();
	clock = new Clock();
	owner = new ApiClient(api());
	key = await owner.setupOwner();
});

describe('issuing tokens', () => {
	it('requires a recent passkey confirmation and shows the token only once', async () => {
		clock.advance(6 * 60 * 1000);
		const denied = await owner.json('/api/owner/v1/tokens', {
			body: { label: 'x', scopes: ['read'] }
		});
		expect(denied.body.code).toBe('reauth_required');

		expect((await owner.login(key, 'reauth')).status).toBe(200);
		const issued = await issue(['read', 'write'], { expiresInDays: 30 });
		expect(issued.token).toMatch(/^ifx_[A-Za-z0-9_-]{43}$/);
		expect(issued.scopes).toEqual(['read', 'write']);
		expect(new Date(issued.expiresAt).getTime() - clock.ms).toBe(30 * 24 * 60 * 60 * 1000);

		const list = await owner.json('/api/owner/v1/tokens');
		expect(list.body.tokens).toHaveLength(1);
		expect(JSON.stringify(list.body)).not.toContain(issued.token);
		const row = await env.DB.prepare('SELECT token_hash FROM api_tokens').first<{
			token_hash: string;
		}>();
		expect(row!.token_hash).not.toContain(issued.token);
	});

	it('validates labels, scopes and expiry', async () => {
		for (const body of [
			{ label: '', scopes: ['read'] },
			{ label: 'x', scopes: [] },
			{ label: 'x', scopes: ['admin'] },
			{ label: 'x', scopes: ['read', 'read'] },
			{ label: 'x', scopes: ['read'], expiresInDays: 0 },
			{ label: 'x', scopes: ['read'], expiresInDays: 366 }
		]) {
			expect(
				(await owner.json('/api/owner/v1/tokens', { body })).status,
				JSON.stringify(body)
			).toBe(422);
		}
	});

	it('can never be done with a token, nor can passkeys or sessions be managed', async () => {
		const { token } = await issue(['read', 'write', 'backup']);
		const c = cli(token);
		expect(
			(await c.json('/api/owner/v1/tokens', { body: { label: 'x', scopes: ['read'] } })).status
		).toBe(403);
		expect((await c.json('/api/owner/v1/tokens')).status).toBe(403);
		expect((await c.json('/api/owner/v1/passkeys')).status).toBe(403);
		expect((await c.json('/api/owner/v1/sessions')).status).toBe(403);
		// Auth routes never accept Bearer tokens.
		expect((await c.json('/api/auth/v1/session')).status).toBe(401);
	});
});

describe('Bearer access', () => {
	it('works without cookies, Origin or CSRF, within its scopes', async () => {
		const { token } = await issue(['read', 'write']);
		const c = cli(token);
		const created = await c.json('/api/owner/v1/pages', { body: newPage({ title: 'CLI で作成' }) });
		expect(created.status).toBe(201);
		const page = await c.json(`/api/owner/v1/pages/${created.body.pageId}`);
		expect(page.body.title).toBe('CLI で作成');
		expect((await c.json('/api/owner/v1/export/start')).status).toBe(403); // needs backup
	});

	it('enforces read-only tokens', async () => {
		const { token } = await issue(['read']);
		const c = cli(token);
		expect((await c.json('/api/owner/v1/titles?q=a')).status).toBe(200);
		expect((await c.json('/api/owner/v1/names/resolve', { body: { names: ['a'] } })).status).toBe(
			200
		);
		const denied = await c.json('/api/owner/v1/pages', { body: newPage() });
		expect(denied).toMatchObject({ status: 403, body: { code: 'forbidden' } });
		expect(denied.body.message).toContain('write');
	});

	it('rejects unknown, malformed, revoked and expired tokens', async () => {
		const { id, token } = await issue(['read'], { expiresInDays: 1 });
		expect((await cli('ifx_nope').json('/api/owner/v1/titles')).status).toBe(401);
		expect((await cli('').json('/api/owner/v1/titles')).status).toBe(401);
		expect((await cli(token).json('/api/owner/v1/titles')).status).toBe(200);

		clock.advance(24 * 60 * 60 * 1000 + 1);
		expect((await cli(token).json('/api/owner/v1/titles')).status).toBe(401);

		await owner.login(key, 'reauth');
		const second = await issue(['read']);
		expect(
			(await owner.json(`/api/owner/v1/tokens/${second.id}`, { method: 'DELETE' })).status
		).toBe(200);
		expect((await cli(second.token).json('/api/owner/v1/titles')).status).toBe(401);
		expect((await owner.json(`/api/owner/v1/tokens/${id}`, { method: 'DELETE' })).status).toBe(200);
	});

	it('rejects a cookie and a token together, and other hosts', async () => {
		const { token } = await issue(['read']);
		const mixed = await owner.json('/api/owner/v1/titles', {
			headers: { authorization: `Bearer ${token}` }
		});
		expect(mixed.status).toBe(400);
		const otherHost = await cli(token).json('/api/owner/v1/titles', {
			url: 'https://evil.example/api/owner/v1/titles'
		});
		expect(otherHost.status).toBe(403);
	});

	it('records when a token was last used, at most hourly', async () => {
		const { token } = await issue(['read']);
		await cli(token).json('/api/owner/v1/titles');
		const first = (await owner.json('/api/owner/v1/tokens')).body.tokens[0].lastUsedAt;
		expect(first).not.toBeNull();
		clock.advance(10 * 60 * 1000);
		await cli(token).json('/api/owner/v1/titles');
		expect((await owner.json('/api/owner/v1/tokens')).body.tokens[0].lastUsedAt).toBe(first);
	});

	it('is revoked by passkey recovery', async () => {
		const { token } = await issue(['read']);
		const recovered = new ApiClient(api());
		await recovered.setupOwner('recovery');
		expect((await cli(token).json('/api/owner/v1/titles')).status).toBe(401);
	});
});

describe('daily "today" for the CLI', () => {
	it('resolves today in the site time zone for GET and POST', async () => {
		const { token } = await issue(['read', 'write']);
		const c = cli(token);
		const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(clock.ms);
		expect((await c.json('/api/owner/v1/daily/today')).status).toBe(404);
		const created = await c.json('/api/owner/v1/daily/today', {
			body: { mutationId: crypto.randomUUID() }
		});
		expect(created).toMatchObject({ status: 201, body: { dailyDate: date } });
		expect((await c.json('/api/owner/v1/daily/today')).body).toMatchObject({
			pageId: created.body.pageId,
			dailyDate: date
		});
	});
});

describe('export', () => {
	it('pins the export to the change feed position and pages through by id', async () => {
		const { token } = await issue(['backup', 'write']);
		const c = cli(token);
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			ids.push(
				(
					await c.json('/api/owner/v1/pages', {
						body: newPage({ title: `p${i}`, source: `v1 ${i}` })
					})
				).body.pageId
			);
		}
		const start = await c.json('/api/owner/v1/export/start');
		expect(start.body).toMatchObject({ pages: 5, assets: 0 });

		// Changes after the start: an edit, a deletion and a new page.
		await c.json(`/api/owner/v1/pages/${ids[0]}`, {
			method: 'PUT',
			body: {
				baseRevision: 1,
				mutationId: crypto.randomUUID(),
				title: 'p0',
				format: 'link-text-v1',
				source: 'v2'
			}
		});
		await c.json(`/api/owner/v1/pages/${ids[1]}`, {
			method: 'DELETE',
			body: { baseRevision: 1, mutationId: crypto.randomUUID() }
		});
		await c.json('/api/owner/v1/pages', { body: newPage({ title: 'later' }) });

		const seen: { id: string; source: string; revision: number }[] = [];
		let cursor = '';
		for (;;) {
			const res = await c.json(
				`/api/owner/v1/export/pages?until=${start.body.highWater}&limit=2&cursor=${cursor}`
			);
			expect(res.status).toBe(200);
			seen.push(...res.body.pages);
			if (!res.body.nextCursor) break;
			cursor = res.body.nextCursor;
		}
		expect(seen.map((p) => p.id).sort()).toEqual([...ids].sort());
		expect(seen.find((p) => p.id === ids[0])).toMatchObject({ source: 'v1 0', revision: 1 });
	});

	it('leaves out pages deleted before the export and lists aliases', async () => {
		const { token } = await issue(['backup', 'write']);
		const c = cli(token);
		const keep = (await c.json('/api/owner/v1/pages', { body: newPage({ title: '旧名' }) })).body
			.pageId;
		const gone = (await c.json('/api/owner/v1/pages', { body: newPage({ title: '消す' }) })).body
			.pageId;
		await c.json(`/api/owner/v1/pages/${keep}`, {
			method: 'PUT',
			body: {
				baseRevision: 1,
				mutationId: crypto.randomUUID(),
				title: '新名',
				format: 'link-text-v1',
				source: 'x'
			}
		});
		await c.json(`/api/owner/v1/pages/${gone}`, {
			method: 'DELETE',
			body: { baseRevision: 1, mutationId: crypto.randomUUID() }
		});
		const start = (await c.json('/api/owner/v1/export/start')).body;
		const res = await c.json(`/api/owner/v1/export/pages?until=${start.highWater}`);
		expect(res.body.pages).toEqual([
			expect.objectContaining({ id: keep, title: '新名', aliases: ['旧名'], revision: 2 })
		]);
		expect((await c.json('/api/owner/v1/export/pages')).status).toBe(400);
	});

	it('lists ready images with their hash for verification', async () => {
		const { pngBytes } = await import('../helpers/images');
		const id = crypto.randomUUID();
		await owner.call(`/api/owner/v1/assets/${id}`, {
			method: 'PUT',
			body: pngBytes(77) as unknown as string,
			headers: { 'content-type': 'image/png' }
		});
		await owner.json(`/api/owner/v1/assets/${id}/complete`, { body: {} });
		const { token } = await issue(['backup']);
		const res = await cli(token).json('/api/owner/v1/export/assets');
		expect(res.body.assets).toEqual([
			expect.objectContaining({ id, mime: 'image/png', width: 1, height: 1, source: 'upload' })
		]);
		expect(res.body.assets[0].url).toMatch(/^\/media\/originals\/[0-9a-f]{64}\.png$/);
		expect(res.body.assets[0].sha256).toBe(res.body.assets[0].url.match(/([0-9a-f]{64})/)[1]);
	});
});
