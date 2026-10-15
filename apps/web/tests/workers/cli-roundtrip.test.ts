/**
 * Export → empty site → import (design §17 Phase 7 "空DBへの復元用fixture", ADR 0016).
 * Runs the CLI's export / import code against the real API inside workerd.
 */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { Api } from '../../../cli/src/api';
import { exportAll, importAll } from '../../../cli/src/export';
import { memoryStore, sha256Hex } from '../../../cli/src/files';
import { createApi } from '../../src/lib/server/api/app';
import { ApiClient, ORIGIN, config, newPage, resetDb } from '../helpers/api-client';
import { pngBytes } from '../helpers/images';

const app = createApi({
	db: env.DB,
	config,
	pending: env.PENDING,
	media: env.MEDIA,
	mediaBaseUrl: '/media',
	timeZone: 'Asia/Tokyo'
});

/** The CLI's fetch: the Hono app for /api, the MEDIA bucket for /media (like the Worker). */
async function siteFetch(url: string, init?: RequestInit): Promise<Response> {
	const u = new URL(url);
	if (u.pathname.startsWith('/media/')) {
		const object = await env.MEDIA.get(u.pathname.slice('/media/'.length));
		return object
			? new Response(await object.arrayBuffer())
			: new Response('not found', { status: 404 });
	}
	return app.request(url, init);
}

async function ownerWithToken(): Promise<{ owner: ApiClient; cli: Api }> {
	const owner = new ApiClient(app);
	await owner.setupOwner();
	const issued = await owner.json('/api/owner/v1/tokens', {
		body: { label: 'test', scopes: ['read', 'write', 'backup'] }
	});
	return {
		owner,
		cli: new Api({ baseUrl: ORIGIN, token: issued.body.token, fetch: siteFetch, retryDelays: [] })
	};
}

const snapshot = async () =>
	(
		await env.DB.prepare(
			`SELECT p.id, p.title, p.source, p.daily_date,
			   (SELECT group_concat(name_key, '|') FROM (SELECT name_key FROM page_names n
			     WHERE n.page_id = p.id ORDER BY name_key)) AS names
			 FROM pages p WHERE deleted_at IS NULL ORDER BY id`
		).all()
	).results;

beforeEach(resetDb);

describe('export and restore', () => {
	it('restores pages, daily dates, aliases, links and images into an empty site', async () => {
		const { owner, cli } = await ownerWithToken();
		const image = crypto.randomUUID();
		await owner.call(`/api/owner/v1/assets/${image}`, {
			method: 'PUT',
			body: pngBytes(5) as unknown as string,
			headers: { 'content-type': 'image/png' }
		});
		await owner.json(`/api/owner/v1/assets/${image}/complete`, { body: {} });
		const reading = (
			await owner.json('/api/owner/v1/pages', { body: newPage({ title: '読書', source: '入口' }) })
		).body.pageId;
		await owner.json('/api/owner/v1/pages', {
			body: {
				...newPage({ title: '2026-10-16', source: `[読書] の日\n[asset:${image}]` }),
				dailyDate: '2026-10-16'
			}
		});
		await owner.json(`/api/owner/v1/pages/${reading}`, {
			method: 'PUT',
			body: {
				baseRevision: 1,
				mutationId: crypto.randomUUID(),
				title: '読書ノート',
				format: 'link-text-v1',
				source: '入口'
			}
		});
		const deleted = (await owner.json('/api/owner/v1/pages', { body: newPage({ title: '消す' }) }))
			.body.pageId;
		await owner.json(`/api/owner/v1/pages/${deleted}`, {
			method: 'DELETE',
			body: { baseRevision: 1, mutationId: crypto.randomUUID() }
		});
		const before = await snapshot();

		const store = memoryStore();
		const manifest = await exportAll(cli, store, { withAssets: true });
		expect(manifest).toMatchObject({ pages: 2, assets: { listed: 1, downloaded: 1 } });

		// A new, empty site.
		await resetDb();
		await env.MEDIA.delete((await env.MEDIA.list()).objects.map((o) => o.key));
		const fresh = await ownerWithToken();
		const report = await importAll(fresh.cli, store);
		expect(report).toEqual({
			created: 2,
			unchanged: 0,
			conflicts: [],
			images: { uploaded: 1, missing: 0 }
		});

		expect(await snapshot()).toEqual(before);
		const links = await env.DB.prepare('SELECT target_name_key FROM page_links ORDER BY 1').all();
		expect(links.results).toEqual([{ target_name_key: '読書' }]);
		const restored = await fresh.owner.json(
			`/api/public/v1/resolve?title=${encodeURIComponent('読書')}`
		);
		expect(restored.body).toMatchObject({ pageId: reading, matchedAlias: true });
		const asset = await env.DB.prepare('SELECT status, sha256 FROM assets WHERE id = ?')
			.bind(image)
			.first<{ status: string; sha256: string }>();
		expect(asset?.status).toBe('ready');
		expect(asset?.sha256).toBe(await sha256Hex(pngBytes(5)));

		// Running the import again changes nothing.
		const again = await importAll(fresh.cli, store);
		expect(again).toMatchObject({ created: 0, unchanged: 2, conflicts: [] });
	});

	it('refuses a tampered export', async () => {
		const { owner, cli } = await ownerWithToken();
		await owner.json('/api/owner/v1/pages', { body: newPage({ title: '改ざん', source: '元' }) });
		const store = memoryStore();
		await exportAll(cli, store, { withAssets: false });
		const page = [...store.files.keys()].find((k) => k.startsWith('pages/'))!;
		store.files.set(page, new TextEncoder().encode('書き換え'));
		await expect(importAll(cli, store)).rejects.toThrow('壊れているか変更されています');
	});
});
