/** Related pages, name resolution and title suggestions (design §11.2, §14.2 links). */
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiClient, newPage, resetDb } from '../helpers/api-client';

let owner: ApiClient;

beforeEach(async () => {
	await resetDb();
	owner = new ApiClient();
	await owner.setupOwner();
});

async function page(title: string, source = '') {
	const res = await owner.json('/api/owner/v1/pages', { body: newPage({ title, source }) });
	expect(res.status).toBe(201);
	return res.body.pageId as string;
}

const related = async (id: string) =>
	(await new ApiClient().json(`/api/public/v1/pages/${id}/related`)).body;

describe('related pages', () => {
	it('lists links (resolved and missing), backlinks and shared targets', async () => {
		const reading = await page('読書');
		const a = await page('日記A', '[読書] と [未作成のページ]');
		const b = await page('日記B', '#読書 を読んだ');
		const c = await page('メモ', '[日記A] を参照');

		const r = await related(a);
		expect(r.links).toEqual(
			expect.arrayContaining([
				{ name: '読書', page: { id: reading, title: '読書' } },
				{ name: '未作成のページ', page: null }
			])
		);
		expect(r.backlinks).toEqual([{ id: c, title: 'メモ' }]);
		expect(r.shared).toEqual([
			{
				target: { name: '読書', page: { id: reading, title: '読書' } },
				pages: [{ id: b, title: '日記B' }],
				more: false
			}
		]);

		const target = await related(reading);
		expect(target.backlinks.map((p: { id: string }) => p.id).sort()).toEqual([a, b].sort());
	});

	it('merges links that use an alias of the same page', async () => {
		const id = await page('旧名');
		await owner.json(`/api/owner/v1/pages/${id}`, {
			method: 'PUT',
			body: {
				baseRevision: 1,
				mutationId: crypto.randomUUID(),
				title: '新名',
				format: 'link-text-v1',
				source: ''
			}
		});
		const a = await page('A', '[旧名]');
		const b = await page('B', '[新名]');
		const r = await related(a);
		expect(r.links).toEqual([{ name: '旧名', page: { id, title: '新名' } }]);
		expect(r.shared[0].pages).toEqual([{ id: b, title: 'B' }]);
		expect((await related(id)).backlinks).toHaveLength(2);
	});

	it('bounds hub targets and excludes deleted pages', async () => {
		await page('ハブ');
		const me = await page('自分', '#ハブ');
		const ids: string[] = [];
		for (let i = 0; i < 13; i++) ids.push(await page(`p${i}`, '#ハブ'));
		await owner.json(`/api/owner/v1/pages/${ids[12]}`, {
			method: 'DELETE',
			body: { baseRevision: 1, mutationId: crypto.randomUUID() }
		});
		const r = await related(me);
		expect(r.shared[0].pages).toHaveLength(10);
		expect(r.shared[0].more).toBe(true);
		expect(r.shared[0].pages.map((p: { id: string }) => p.id)).not.toContain(ids[12]);
	});

	it('ignores links inside code', async () => {
		const a = await page('コード', '`[偽リンク]`\n```\n[これも偽]\n```');
		expect((await related(a)).links).toEqual([]);
	});
});

describe('name resolution and suggestions', () => {
	it('resolves titles and aliases for rendering', async () => {
		const id = await page('読書');
		const res = await owner.json('/api/owner/v1/names/resolve', {
			body: { names: ['読書', '未作成'] }
		});
		expect(res.body.pages).toEqual({ 読書: { id, title: '読書' } });
	});

	it('suggests prefix matches before substring matches, escaping LIKE wildcards', async () => {
		await page('読書メモ');
		await page('今月の読書');
		await page('100%_完了');
		const res = await owner.json(`/api/owner/v1/titles?q=${encodeURIComponent('読書')}`);
		expect(res.body.titles.map((t: { title: string }) => t.title)).toEqual([
			'読書メモ',
			'今月の読書'
		]);
		const wild = await owner.json(`/api/owner/v1/titles?q=${encodeURIComponent('%_')}`);
		expect(wild.body.titles.map((t: { title: string }) => t.title)).toEqual(['100%_完了']);
		expect((await new ApiClient().json('/api/owner/v1/titles?q=x')).status).toBe(401);
	});
});
