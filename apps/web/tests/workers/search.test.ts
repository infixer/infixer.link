/** Japanese search (design §11.1, §6.2 "1〜2文字、長文、英数混在", ADR 0013). */
import { beforeEach, describe, expect, it } from 'vitest';
import type { SearchDto } from '@infixer-link/contracts';
import { ApiClient, newPage, resetDb } from '../helpers/api-client';
import { highlight, parseQuery } from '../../src/lib/server/pages/search';

let owner: ApiClient;
const anon = new ApiClient();

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

async function put(id: string, baseRevision: number, title: string, source: string) {
	const res = await owner.json(`/api/owner/v1/pages/${id}`, {
		method: 'PUT',
		body: { baseRevision, mutationId: crypto.randomUUID(), title, format: 'link-text-v1', source }
	});
	expect(res.status).toBe(200);
}

async function search(q: string, extra = ''): Promise<SearchDto> {
	const res = await anon.json(`/api/public/v1/search?q=${encodeURIComponent(q)}${extra}`);
	expect(res.status).toBe(200);
	return res.body;
}

const titles = (r: SearchDto) => r.hits.map((h) => h.title);

describe('query handling', () => {
	it('normalizes whitespace (including full-width spaces) and caps terms and length', () => {
		expect(parseQuery('  読書　 メモ  ')).toEqual({ text: '読書 メモ', terms: ['読書', 'メモ'] });
		expect(parseQuery('a b c d e f g').terms).toHaveLength(5);
		expect([...parseQuery('あ'.repeat(500)).text]).toHaveLength(100);
		expect(parseQuery('a a a').terms).toEqual(['a']);
		expect(parseQuery('   ')).toEqual({ text: '', terms: [] });
	});

	it('highlights matches case-insensitively for ASCII and merges overlapping matches', () => {
		expect(highlight('Deleuze and deleuze', ['deleuze'])).toEqual([
			{ text: 'Deleuze', hit: true },
			{ text: ' and ', hit: false },
			{ text: 'deleuze', hit: true }
		]);
		expect(highlight('xababay', ['aba', 'bab'])).toEqual([
			{ text: 'x', hit: false },
			{ text: 'abab', hit: true },
			{ text: 'ay', hit: false }
		]);
	});

	it('returns nothing for an empty query and is publicly readable without a session', async () => {
		await page('読書');
		const res = await anon.call('/api/public/v1/search?q=');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ query: '', hits: [], nextOffset: null });
		expect(res.headers.get('cache-control')).toBe('no-cache');
	});
});

describe('Japanese matching', () => {
	beforeEach(async () => {
		await page('アンチ・オイディプス', 'ドゥルーズ＝ガタリの本。欲望する機械について。');
		await page('2026-10-15', '今日は本を読んだ。\n [アンチ・オイディプス] の続き');
		await page('料理', '味噌汁を作った。出汁は昆布。');
	});

	it('finds one-character terms with the LIKE fallback', async () => {
		expect(titles(await search('本')).sort()).toEqual(['2026-10-15', 'アンチ・オイディプス']);
		expect(titles(await search('汁'))).toEqual(['料理']);
	});

	it('finds two-character terms with the LIKE fallback', async () => {
		expect(titles(await search('昆布'))).toEqual(['料理']);
		expect(titles(await search('機械'))).toEqual(['アンチ・オイディプス']);
	});

	it('finds three or more characters with FTS5 trigram', async () => {
		expect(titles(await search('ガタリの'))).toEqual(['アンチ・オイディプス']);
		expect(titles(await search('味噌汁'))).toEqual(['料理']);
	});

	it('ANDs terms and mixes trigram and short terms', async () => {
		expect(titles(await search('ドゥルーズ 機械'))).toEqual(['アンチ・オイディプス']);
		expect(titles(await search('ドゥルーズ 昆布'))).toEqual([]);
		expect(titles(await search('本 続き'))).toEqual(['2026-10-15']);
	});

	it('ranks title matches before body matches and returns an excerpt with highlights', async () => {
		const r = await search('アンチ・オイディプス');
		expect(titles(r)).toEqual(['アンチ・オイディプス', '2026-10-15']);
		expect(r.hits.map((h) => h.match)).toEqual(['title', 'body']);
		const body = r.hits[1]!.excerpt;
		expect(body.filter((p) => p.hit).map((p) => p.text)).toEqual(['アンチ・オイディプス']);
		expect(body.map((p) => p.text).join('')).toBe(
			'今日は本を読んだ。 [アンチ・オイディプス] の続き'
		);
	});
});

describe('mixed alphanumerics and long pages', () => {
	it('matches ASCII case-insensitively in both paths and Japanese next to Latin text', async () => {
		await page('SvelteKit メモ', 'Cloudflare Workers で動かす。D1 と R2。');
		expect(titles(await search('sveltekit'))).toEqual(['SvelteKit メモ']);
		expect(titles(await search('WORKERS'))).toEqual(['SvelteKit メモ']);
		expect(titles(await search('d1'))).toEqual(['SvelteKit メモ']);
		expect(titles(await search('で動か'))).toEqual(['SvelteKit メモ']);
		expect(titles(await search('r2。'))).toEqual(['SvelteKit メモ']);
	});

	it('finds a term deep inside a long page and centers the excerpt on it', async () => {
		const filler = 'あいうえおかきくけこ\n'.repeat(3000);
		await page('長文', `${filler}ここに目印がある${filler}`);
		const r = await search('目印');
		expect(titles(r)).toEqual(['長文']);
		const text = r.hits[0]!.excerpt.map((p) => p.text).join('');
		expect(text.startsWith('…')).toBe(true);
		expect(text.endsWith('…')).toBe(true);
		expect(text).toContain('ここに目印がある');
		expect([...text].length).toBeLessThan(120);
		expect(titles(await search('に目印が'))).toEqual(['長文']);
	});
});

describe('names', () => {
	it('puts exact, prefix and substring title matches first and finds pages by an old name', async () => {
		const reading = await page('読書', '入口');
		await page('読書メモ', '');
		await page('今月の読書', '');
		await page('日記', '読書をした');
		const r = await search('読書');
		expect(titles(r)).toEqual(['読書', '読書メモ', '今月の読書', '日記']);
		expect(r.hits.map((h) => h.match)).toEqual(['title', 'title', 'title', 'body']);

		await put(reading, 1, '読書ノート', '入口');
		const renamed = await search('読書');
		expect(renamed.hits[0]).toMatchObject({
			id: reading,
			title: '読書ノート',
			match: 'alias',
			alias: '読書'
		});
	});
});

describe('the index follows edits', () => {
	it('reflects updates, deletion and restore', async () => {
		const id = await page('変化', '最初の文章です');
		expect(titles(await search('最初の'))).toEqual(['変化']);

		await put(id, 1, '変化', '書き直した本文です');
		expect(titles(await search('最初の'))).toEqual([]);
		expect(titles(await search('書き直した'))).toEqual(['変化']);
		expect(titles(await search('最初'))).toEqual([]);

		const del = await owner.json(`/api/owner/v1/pages/${id}`, {
			method: 'DELETE',
			body: { baseRevision: 2, mutationId: crypto.randomUUID() }
		});
		expect(del.status).toBe(200);
		expect(titles(await search('書き直した'))).toEqual([]);
		expect(titles(await search('書き'))).toEqual([]);
		expect(titles(await search('変化'))).toEqual([]);

		const restored = await owner.json(`/api/owner/v1/pages/${id}/restore`, {
			body: { baseRevision: 3, mutationId: crypto.randomUUID() }
		});
		expect(restored.status).toBe(200);
		expect(titles(await search('書き直した'))).toEqual(['変化']);
	});
});

describe('safety', () => {
	it('treats FTS syntax and LIKE wildcards as literal text', async () => {
		await page('記号', 'a "quoted" NEAR(x y) 100% done_ok * end');
		await page('ほか', 'plain text without them 100 doneXok');
		for (const q of [
			'"quoted"',
			'NEAR(x',
			'100%',
			'done_ok',
			'*',
			'OR',
			'"',
			'quoted" OR "plain'
		]) {
			const r = await search(q);
			expect(titles(r), q).toEqual(q === 'OR' || q.includes('plain') ? [] : ['記号']);
		}
		expect(titles(await search('%'))).toEqual(['記号']);
		expect(titles(await search('_'))).toEqual(['記号']);
	});
});

describe('paging', () => {
	it('pages through results without duplicates or gaps, including equal timestamps', async () => {
		const ids: string[] = [];
		for (let i = 0; i < 7; i++) ids.push(await page(`ページ${i}`, '共通の語句'));
		const seen: string[] = [];
		let offset: number | null = 0;
		while (offset !== null) {
			const r: SearchDto = await search('共通の語句', `&limit=3&offset=${offset}`);
			seen.push(...r.hits.map((h) => h.id));
			offset = r.nextOffset;
		}
		expect(seen).toHaveLength(7);
		expect(new Set(seen)).toEqual(new Set(ids));
	});

	it('stops at the depth limit and clamps bad parameters', async () => {
		await page('一件', '語句');
		const r = await search('語句', '&limit=9999&offset=-5');
		expect(titles(r)).toEqual(['一件']);
		expect((await search('語句', '&offset=100000')).hits).toEqual([]);
	});
});
