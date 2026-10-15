/**
 * Page persistence against the real migrations: atomic derived data, conflicts,
 * idempotent replays, soft delete / restore and public visibility (design §7.3, §14.2).
 */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiClient, newPage, resetDb } from '../helpers/api-client';

const db = env.DB;
let owner: ApiClient;

beforeEach(async () => {
	await resetDb();
	owner = new ApiClient();
	await owner.setupOwner();
});

async function create(overrides: Record<string, unknown> = {}) {
	const body = newPage(overrides);
	const res = await owner.json('/api/owner/v1/pages', { body });
	expect(res.status).toBe(201);
	return { ...res.body, request: body };
}

function update(id: string, baseRevision: number, overrides: Record<string, unknown> = {}) {
	return owner.json(`/api/owner/v1/pages/${id}`, {
		method: 'PUT',
		body: {
			baseRevision,
			mutationId: crypto.randomUUID(),
			title: 'メモ',
			format: 'link-text-v1',
			source: 'b',
			...overrides
		}
	});
}

async function derived(id: string) {
	const [revisions, links, names, changes, fts, assets] = await db.batch<Record<string, unknown>>([
		db
			.prepare('SELECT revision, operation FROM page_revisions WHERE page_id = ? ORDER BY revision')
			.bind(id),
		db
			.prepare('SELECT target_name_key FROM page_links WHERE source_page_id = ? ORDER BY 1')
			.bind(id),
		db.prepare('SELECT name_key, kind FROM page_names WHERE page_id = ? ORDER BY 1').bind(id),
		db.prepare('SELECT revision, operation FROM changes WHERE page_id = ? ORDER BY seq').bind(id),
		db.prepare('SELECT title, source FROM pages_fts WHERE page_id = ?').bind(id),
		db.prepare('SELECT asset_id FROM page_assets WHERE page_id = ?').bind(id)
	]);
	return {
		revisions: revisions.results,
		links: links.results.map((r) => r.target_name_key),
		names: names.results,
		changes: changes.results,
		fts: fts.results,
		assets: assets.results.map((r) => r.asset_id)
	};
}

describe('create', () => {
	it('creates a page with server-extracted links, history, change feed and search row', async () => {
		const result = await create({
			title: '2026-10-15',
			source: '今日のメモ\n [読書] #日記\n [asset:550e8400-e29b-41d4-a716-446655440000]',
			dailyDate: '2026-10-15'
		});
		expect(result).toMatchObject({ revision: 1, replayed: false, changeSeq: expect.any(Number) });
		expect(await derived(result.pageId)).toEqual({
			revisions: [{ revision: 1, operation: 'create' }],
			links: ['日記', '読書'],
			names: [{ name_key: '2026-10-15', kind: 'canonical' }],
			changes: [{ revision: 1, operation: 'create' }],
			fts: [{ title: '2026-10-15', source: expect.stringContaining('今日のメモ') }],
			assets: ['550e8400-e29b-41d4-a716-446655440000']
		});
	});

	it('rejects client-supplied derived data', async () => {
		const res = await owner.json('/api/owner/v1/pages', { body: { ...newPage(), links: ['x'] } });
		expect(res.status).toBe(422);
		expect(res.body.code).toBe('validation_failed');
	});

	it('returns 409 for a duplicate name (NFC-equal) and keeps no partial rows', async () => {
		await create({ title: 'ガ' });
		const before = await db.prepare('SELECT count(*) AS n FROM page_revisions').first('n');
		const res = await owner.json('/api/owner/v1/pages', { body: newPage({ title: ' ガ ' }) });
		expect(res.status).toBe(409);
		expect(res.body.code).toBe('name_conflict');
		expect(await db.prepare('SELECT count(*) AS n FROM page_revisions').first('n')).toBe(before);
	});

	it('does not create two daily pages for the same date', async () => {
		await create({ title: '日記A', dailyDate: '2026-10-15' });
		const res = await owner.json('/api/owner/v1/pages', {
			body: newPage({ title: '日記B', dailyDate: '2026-10-15' })
		});
		expect(res.body.code).toBe('daily_conflict');
	});

	it('replays a lost response without creating a second page', async () => {
		const body = newPage({ id: crypto.randomUUID() });
		const first = await owner.json('/api/owner/v1/pages', { body });
		const second = await owner.json('/api/owner/v1/pages', { body });
		expect(first.status).toBe(201);
		expect(second.status).toBe(200);
		expect(second.body).toEqual({ ...first.body, replayed: true });
		expect(await db.prepare('SELECT count(*) AS n FROM pages').first('n')).toBe(1);
	});

	it('handles concurrent duplicates of the same mutation', async () => {
		const body = newPage({ id: crypto.randomUUID() });
		const results = await Promise.all(
			[1, 2, 3].map(() => owner.json('/api/owner/v1/pages', { body }))
		);
		expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
		expect(new Set(results.map((r) => r.body.revision))).toEqual(new Set([1]));
	});

	it('rejects reuse of a mutationId with different content', async () => {
		const body = newPage();
		await owner.json('/api/owner/v1/pages', { body });
		const res = await owner.json('/api/owner/v1/pages', { body: { ...body, source: 'changed' } });
		expect(res.status).toBe(409);
		expect(res.body.code).toBe('mutation_conflict');
	});

	it('enforces size limits', async () => {
		const res = await owner.json('/api/owner/v1/pages', {
			body: newPage({ source: 'あ'.repeat(90_000) }) // 270,000 bytes > 256 KiB
		});
		expect(res.status).toBe(413);
		const links = Array.from({ length: 1001 }, (_, i) => `[l${i}]`).join(' ');
		expect(
			(await owner.json('/api/owner/v1/pages', { body: newPage({ source: links }) })).status
		).toBe(413);
	});
});

describe('update', () => {
	it('advances the revision and replaces links atomically', async () => {
		const page = await create({ title: 'メモ', source: '[A]' });
		const res = await update(page.pageId, 1, { source: '[B] [C]' });
		expect(res.status).toBe(200);
		expect(res.body.revision).toBe(2);
		const d = await derived(page.pageId);
		expect(d.links).toEqual(['B', 'C']);
		expect(d.revisions).toHaveLength(2);
		expect(d.fts).toEqual([{ title: 'メモ', source: '[B] [C]' }]);
	});

	it('lets exactly one of two updates from the same base revision win', async () => {
		const page = await create({ title: 'メモ' });
		const [a, b] = await Promise.all([
			update(page.pageId, 1, { source: 'from A' }),
			update(page.pageId, 1, { source: 'from B' })
		]);
		expect([a.status, b.status].sort()).toEqual([200, 409]);
		const loser = a.status === 409 ? a : b;
		expect(loser.body).toMatchObject({
			code: 'revision_conflict',
			details: { currentRevision: 2 }
		});
		const d = await derived(page.pageId);
		expect(d.revisions).toHaveLength(2);
	});

	it('replays an update whose response was lost even though the revision moved on', async () => {
		const page = await create({ title: 'メモ' });
		const body = {
			baseRevision: 1,
			mutationId: crypto.randomUUID(),
			title: 'メモ',
			format: 'link-text-v1',
			source: 'x'
		};
		const first = await owner.json(`/api/owner/v1/pages/${page.pageId}`, { method: 'PUT', body });
		await update(page.pageId, 2, { source: 'later edit' });
		const retry = await owner.json(`/api/owner/v1/pages/${page.pageId}`, { method: 'PUT', body });
		expect(retry.status).toBe(200);
		expect(retry.body).toEqual({ ...first.body, replayed: true });
	});

	it('renames, keeps the old name as an alias and resolves both', async () => {
		const page = await create({ title: '旧名' });
		await update(page.pageId, 1, { title: '新名' });
		expect((await derived(page.pageId)).names).toEqual([
			{ name_key: '新名', kind: 'canonical' },
			{ name_key: '旧名', kind: 'alias' }
		]);
		const resolved = await owner.json(`/api/public/v1/resolve?title=${encodeURIComponent('旧名')}`);
		expect(resolved.body).toEqual({ pageId: page.pageId, title: '新名', matchedAlias: true });
	});

	it('rolls back everything when a rename collides with another page', async () => {
		await create({ title: '読書' });
		const page = await create({ title: '日記', source: '[X]' });
		const before = await derived(page.pageId);
		const res = await update(page.pageId, 1, { title: '読書', source: '[Z]' });
		expect(res.body.code).toBe('name_conflict');
		expect(await derived(page.pageId)).toEqual(before);
		expect((await owner.json(`/api/owner/v1/pages/${page.pageId}`)).body).toMatchObject({
			title: '日記',
			revision: 1
		});
	});

	it('returns 404 for unknown pages and 409 page_deleted for deleted ones', async () => {
		expect((await update(crypto.randomUUID(), 1)).status).toBe(404);
		expect((await update('not-a-uuid', 1)).status).toBe(404);
		const page = await create();
		await owner.json(`/api/owner/v1/pages/${page.pageId}`, {
			method: 'DELETE',
			body: { baseRevision: 1, mutationId: crypto.randomUUID() }
		});
		expect((await update(page.pageId, 2)).body.code).toBe('page_deleted');
	});
});

describe('delete and restore', () => {
	it('soft-deletes: hidden from public reads, list, resolve and search; history kept', async () => {
		const page = await create({ title: '消す', source: 'ひみつの本文です' });
		const del = await owner.json(`/api/owner/v1/pages/${page.pageId}`, {
			method: 'DELETE',
			body: { baseRevision: 1, mutationId: crypto.randomUUID() }
		});
		expect(del.body.revision).toBe(2);
		const anon = new ApiClient();
		expect((await anon.json(`/api/public/v1/pages/${page.pageId}`)).status).toBe(404);
		expect((await anon.json('/api/public/v1/pages')).body.pages).toEqual([]);
		expect(
			(await anon.json(`/api/public/v1/resolve?title=${encodeURIComponent('消す')}`)).status
		).toBe(404);
		expect((await derived(page.pageId)).fts).toEqual([]);
		// The name stays reserved for restore.
		const reuse = await owner.json('/api/owner/v1/pages', { body: newPage({ title: '消す' }) });
		expect(reuse.body.code).toBe('name_conflict');
		// Owner can still read it.
		expect((await owner.json(`/api/owner/v1/pages/${page.pageId}`)).body.deletedAt).not.toBeNull();
	});

	it('restores a deleted page as a new revision with search and links back', async () => {
		const page = await create({ title: '戻す', source: '[リンク先] 復元される本文' });
		await owner.json(`/api/owner/v1/pages/${page.pageId}`, {
			method: 'DELETE',
			body: { baseRevision: 1, mutationId: crypto.randomUUID() }
		});
		const res = await owner.json(`/api/owner/v1/pages/${page.pageId}/restore`, {
			body: { baseRevision: 2, mutationId: crypto.randomUUID() }
		});
		expect(res.body.revision).toBe(3);
		const d = await derived(page.pageId);
		expect(d.revisions.map((r) => r.operation)).toEqual(['create', 'delete', 'restore']);
		expect(d.fts).toHaveLength(1);
		expect(d.links).toEqual(['リンク先']);
		expect((await new ApiClient().json(`/api/public/v1/pages/${page.pageId}`)).status).toBe(200);
	});

	it('restores an older revision of a live page', async () => {
		const page = await create({ title: '版', source: 'v1' });
		await update(page.pageId, 1, { title: '版', source: 'v2' });
		const res = await owner.json(`/api/owner/v1/pages/${page.pageId}/restore`, {
			body: { baseRevision: 2, mutationId: crypto.randomUUID(), fromRevision: 1 }
		});
		expect(res.status).toBe(200);
		expect((await owner.json(`/api/owner/v1/pages/${page.pageId}`)).body).toMatchObject({
			source: 'v1',
			revision: 3
		});
		const history = await owner.json(`/api/owner/v1/pages/${page.pageId}/revisions`);
		expect(history.body.revisions.map((r: { revision: number }) => r.revision)).toEqual([3, 2, 1]);
	});
});

describe('public reads', () => {
	it('lists pages by update time with a stable cursor and no duplicates', async () => {
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) ids.push((await create({ title: `p${i}` })).pageId);
		const anon = new ApiClient();
		const first = await anon.json('/api/public/v1/pages?limit=2');
		const second = await anon.json(`/api/public/v1/pages?limit=2&cursor=${first.body.nextCursor}`);
		const third = await anon.json(`/api/public/v1/pages?limit=2&cursor=${second.body.nextCursor}`);
		const seen = [...first.body.pages, ...second.body.pages, ...third.body.pages].map((p) => p.id);
		expect(new Set(seen).size).toBe(5);
		expect(third.body.nextCursor).toBeNull();
		expect(first.body.pages[0]).not.toHaveProperty('source');
		expect((await anon.json('/api/public/v1/pages?cursor=%%%')).status).toBe(400);
	});

	it('serves ETag revalidation and never exposes owner-only fields', async () => {
		const page = await create();
		const anon = new ApiClient();
		const res = await anon.call(`/api/public/v1/pages/${page.pageId}`);
		expect(res.headers.get('cache-control')).toBe('no-cache');
		const etag = res.headers.get('etag')!;
		const body = await res.json();
		expect(body).not.toHaveProperty('deletedAt');
		const again = await anon.call(`/api/public/v1/pages/${page.pageId}`, {
			headers: { 'if-none-match': etag }
		});
		expect(again.status).toBe(304);
	});
});
