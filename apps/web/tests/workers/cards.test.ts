/** List cards and YouTube previews (ADR 0014). */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PageListDto } from '@infixer-link/contracts';
import { createApi } from '../../src/lib/server/api/app';
import { fetchPreview } from '../../src/lib/server/previews';
import { ApiClient, config, newPage, resetDb } from '../helpers/api-client';
import { pngBytes } from '../helpers/images';

const VIDEO = 'https://youtu.be/dQw4w9WgXcQ';
const OEMBED =
	'https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ';
const THUMB = 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg';

function fakeFetcher(routes: Record<string, () => Response>) {
	const calls: string[] = [];
	const fetcher = async (input: string) => {
		calls.push(input);
		return routes[input]?.() ?? new Response('not found', { status: 404 });
	};
	return { calls, fetcher };
}

const png = (variant: number) => () =>
	new Response(pngBytes(variant), { headers: { 'content-type': 'image/png' } });

let owner: ApiClient;
let routes: Record<string, () => Response>;

beforeEach(async () => {
	await resetDb();
	routes = {};
	owner = new ApiClient(
		createApi({
			db: env.DB,
			config,
			fetcher: (input) => fakeFetcher(routes).fetcher(input),
			media: env.MEDIA,
			pending: env.PENDING,
			mediaBaseUrl: '/media'
		})
	);
	await owner.setupOwner();
});

async function page(title: string, source: string) {
	const res = await owner.json('/api/owner/v1/pages', { body: newPage({ title, source }) });
	expect(res.status).toBe(201);
	return res.body.pageId as string;
}

async function upload(variant: number) {
	const id = crypto.randomUUID();
	const put = await owner.call(`/api/owner/v1/assets/${id}`, {
		method: 'PUT',
		body: pngBytes(variant) as unknown as string,
		headers: { 'content-type': 'image/png' }
	});
	expect(put.status).toBe(200);
	expect((await owner.json(`/api/owner/v1/assets/${id}/complete`, { body: {} })).status).toBe(200);
	return id;
}

async function list(): Promise<PageListDto> {
	const res = await new ApiClient().json('/api/public/v1/pages');
	expect(res.status).toBe(200);
	return res.body;
}

const card = async (title: string) => (await list()).pages.find((p) => p.title === title)!;

describe('list cards', () => {
	it('shows the first lines as text when a page has no image', async () => {
		await page(
			'テキストだけ',
			'# 見出し\n\n[* 太字] と [リンク]\nhttps://example.org/only-url\n最後'
		);
		expect(await card('テキストだけ')).toMatchObject({
			thumbnail: null,
			excerpt: ['見出し', '太字 と リンク', '最後']
		});
	});

	it('uses the first uploaded image, with its size', async () => {
		const first = await upload(1);
		const second = await upload(2);
		await page('画像', `文章\n[asset:${first}]\n[asset:${second}]`);
		const c = await card('画像');
		expect(c.thumbnail).toMatchObject({ width: 1, height: 1 });
		const row = await env.DB.prepare('SELECT object_key FROM assets WHERE id = ?')
			.bind(first)
			.first<{ object_key: string }>();
		expect(c.thumbnail!.url).toBe(`/media/${row!.object_key}`);
	});

	it('skips candidates without a ready image and picks the next one in order', async () => {
		const ready = await upload(3);
		const notUploaded = crypto.randomUUID();
		await page('順番', `https://example.org/no-image\n[asset:${notUploaded}]\n[asset:${ready}]`);
		const c = await card('順番');
		const row = await env.DB.prepare('SELECT object_key FROM assets WHERE id = ?')
			.bind(ready)
			.first<{ object_key: string }>();
		expect(c.thumbnail?.url).toBe(`/media/${row!.object_key}`);
	});

	it('uses a link card image once the owner has fetched the preview', async () => {
		routes['https://example.org/a'] = () =>
			new Response(
				'<html><head><meta property="og:title" content="記事"><meta property="og:image" content="https://example.org/i.png"></head></html>',
				{ headers: { 'content-type': 'text/html' } }
			);
		routes['https://example.org/i.png'] = png(7);
		await page('カード', '前置き\nhttps://example.org/a');
		expect((await card('カード')).thumbnail).toBeNull();

		await owner.json('/api/owner/v1/link-previews', { body: { urls: ['https://example.org/a'] } });
		expect((await card('カード')).thumbnail?.url).toMatch(
			/^\/media\/originals\/[0-9a-f]{64}\.png$/
		);
	});

	it('updates candidates on edit and on restore', async () => {
		const img = await upload(4);
		const id = await page('編集', 'まだ画像なし');
		expect((await card('編集')).thumbnail).toBeNull();
		const put = await owner.json(`/api/owner/v1/pages/${id}`, {
			method: 'PUT',
			body: {
				baseRevision: 1,
				mutationId: crypto.randomUUID(),
				title: '編集',
				format: 'link-text-v1',
				source: `[asset:${img}]`
			}
		});
		expect(put.status).toBe(200);
		expect((await card('編集')).thumbnail).not.toBeNull();

		const restored = await owner.json(`/api/owner/v1/pages/${id}/restore`, {
			body: { baseRevision: 2, mutationId: crypto.randomUUID(), fromRevision: 1 }
		});
		expect(restored.status).toBe(200);
		expect((await card('編集')).thumbnail).toBeNull();
	});
});

describe('YouTube previews', () => {
	it('reads the title from oEmbed and copies the thumbnail into R2', async () => {
		routes[OEMBED] = () =>
			Response.json({ title: '動画のタイトル', author_name: 'チャンネル', type: 'video' });
		routes[THUMB] = png(9);
		await page('動画', `https://www.youtube.com/watch?v=dQw4w9WgXcQ\n${VIDEO}`);
		const res = await owner.json('/api/owner/v1/link-previews', { body: { urls: [VIDEO] } });
		expect(res.body.previews[VIDEO]).toMatchObject({
			ok: true,
			title: '動画のタイトル',
			description: 'チャンネル',
			siteName: 'YouTube',
			image: { width: 1, height: 1 }
		});
		expect(res.body.previews[VIDEO].image.url).toMatch(/^\/media\/originals\//);
		// The list card uses the first candidate with an image: the watch URL line has no
		// preview yet, so the youtu.be line's thumbnail is used.
		expect((await card('動画')).thumbnail?.url).toBe(res.body.previews[VIDEO].image.url);
	});

	it('still stores the thumbnail when oEmbed fails, and retries the lookup soon', async () => {
		routes[THUMB] = png(10);
		const { fetcher, calls } = fakeFetcher(routes);
		const p = await fetchPreview(VIDEO, { fetcher, allowLocal: false });
		expect(p).toMatchObject({ status: 'error', title: null, image_url: THUMB });
		expect(calls).toEqual([OEMBED]);

		const res = await owner.json('/api/owner/v1/link-previews', { body: { urls: [VIDEO] } });
		expect(res.body.previews[VIDEO]).toMatchObject({ ok: false, image: { width: 1, height: 1 } });
	});

	it('never fetches the page HTML of a video URL', async () => {
		const { fetcher, calls } = fakeFetcher({});
		await fetchPreview('https://www.youtube.com/shorts/dQw4w9WgXcQ', {
			fetcher,
			allowLocal: false
		});
		expect(calls).toEqual([OEMBED]);
	});
});
