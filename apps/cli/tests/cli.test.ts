import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Api, checkBaseUrl } from '../src/api.ts';
import { CliError, EXIT } from '../src/errors.ts';
import { exportAll } from '../src/export.ts';
import { checkRelative, memoryStore } from '../src/files.ts';
import { nodeStore } from '../src/node-files.ts';
import { append, appendText, resolveTarget } from '../src/pages.ts';

type Call = { url: string; method: string; body: unknown; auth: string | null };

/** Fake site: routes keyed by "METHOD path"; a route may throw to simulate a dropped connection. */
function site(routes: Record<string, (call: Call) => Response | Promise<Response>>) {
	const calls: Call[] = [];
	const fetch = async (url: string, init: RequestInit = {}) => {
		const headers = new Headers(init.headers);
		const call: Call = {
			url,
			method: init.method ?? 'GET',
			body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
			auth: headers.get('authorization')
		};
		calls.push(call);
		const u = new URL(url);
		const route =
			routes[`${call.method} ${u.pathname}${u.search}`] ?? routes[`${call.method} ${u.pathname}`];
		if (!route) return Response.json({ code: 'not_found', message: 'Not found' }, { status: 404 });
		return route(call);
	};
	const api = new Api({
		baseUrl: 'https://infixer.link',
		token: 'ifx_secret',
		fetch,
		retryDelays: [0, 0, 0],
		sleep: async () => {}
	});
	return { api, calls };
}

const ID = '11111111-1111-4111-8111-111111111111';
const page = (revision: number, source: string) =>
	Response.json({ id: ID, title: '日記', source, revision, deletedAt: null });

describe('base URL', () => {
	it('requires https except for local development', () => {
		expect(checkBaseUrl('https://infixer.link/x')).toBe('https://infixer.link');
		expect(checkBaseUrl('http://localhost:4173')).toBe('http://localhost:4173');
		expect(() => checkBaseUrl('http://infixer.link')).toThrow(CliError);
		expect(() => checkBaseUrl('ftp://x')).toThrow(CliError);
	});
});

describe('append', () => {
	it('adds the text as new lines after the existing body', () => {
		expect(appendText('', '読書メモ')).toBe('読書メモ');
		expect(appendText('一行目\n\n', '追記\r\n二行\n')).toBe('一行目\n追記\n二行');
	});

	it('retries a dropped connection with the same mutationId', async () => {
		let puts = 0;
		const { api, calls } = site({
			[`GET /api/owner/v1/pages/${ID}`]: () => page(3, '朝'),
			[`PUT /api/owner/v1/pages/${ID}`]: () => {
				if (++puts === 1) throw new TypeError('fetch failed');
				return Response.json({ pageId: ID, revision: 4, replayed: false });
			}
		});
		const result = await append(api, ID, '夜', () => 'mutation-1');
		expect(result.revision).toBe(4);
		const bodies = calls.filter((c) => c.method === 'PUT').map((c) => c.body);
		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toEqual(bodies[1]);
		expect(bodies[0]).toMatchObject({
			baseRevision: 3,
			mutationId: 'mutation-1',
			source: '朝\n夜'
		});
	});

	it('stops with exit code 4 on a revision conflict and does not append again', async () => {
		const { api, calls } = site({
			[`GET /api/owner/v1/pages/${ID}`]: () => page(3, '朝'),
			[`PUT /api/owner/v1/pages/${ID}`]: () =>
				Response.json({ code: 'revision_conflict', message: 'changed' }, { status: 409 })
		});
		const error = await append(api, ID, '夜').catch((e: CliError) => e);
		expect(error).toBeInstanceOf(CliError);
		expect((error as CliError).exitCode).toBe(EXIT.conflict);
		expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
	});

	it('reports authentication and network failures with their exit codes, without the token', async () => {
		const expired = site({
			[`GET /api/owner/v1/pages/${ID}`]: () =>
				Response.json({ code: 'unauthenticated', message: 'x' }, { status: 401 })
		});
		const auth = (await append(expired.api, ID, 'x').catch((e) => e)) as CliError;
		expect(auth.exitCode).toBe(EXIT.auth);
		expect(auth.message).not.toContain('ifx_secret');

		const offline = site({
			[`GET /api/owner/v1/pages/${ID}`]: () => {
				throw new TypeError('fetch failed');
			}
		});
		const net = (await append(offline.api, ID, 'x').catch((e) => e)) as CliError;
		expect(net.exitCode).toBe(EXIT.network);
		expect(offline.calls).toHaveLength(4); // first try + 3 retries
	});
});

describe('targets', () => {
	it('creates today only when asked, and resolves titles through the public API', async () => {
		const { api, calls } = site({
			'GET /api/owner/v1/daily/today': () =>
				Response.json({ code: 'not_found', message: 'x' }, { status: 404 }),
			'POST /api/owner/v1/daily/today': () => Response.json({ pageId: ID }, { status: 201 }),
			'GET /api/public/v1/resolve': () => Response.json({ pageId: ID, title: '読書' })
		});
		await expect(resolveTarget(api, 'today')).rejects.toMatchObject({
			exitCode: EXIT.notFound
		});
		expect(await resolveTarget(api, 'today', { createToday: true })).toBe(ID);
		expect(await resolveTarget(api, '読書')).toBe(ID);
		expect(calls.at(-1)!.auth).toBeNull(); // public endpoint: no token
		expect(await resolveTarget(api, ID.toUpperCase())).toBe(ID);
	});
});

describe('files', () => {
	it('accepts only id-based names inside the export directory', () => {
		for (const ok of ['manifest.json', `pages/${ID}.link.txt`, `assets/${ID}.png`]) {
			expect(checkRelative(ok)).toBe(ok);
		}
		for (const bad of [
			'../x.json',
			'/etc/passwd',
			'pages/../../x.txt',
			'a/b/c.txt',
			'pages/日記.txt',
			''
		]) {
			expect(() => checkRelative(bad), bad).toThrow(CliError);
		}
	});

	it('never overwrites files and refuses a non-empty directory', async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), 'infixer-'));
		const store = nodeStore(dir);
		expect(await store.isEmpty()).toBe(true);
		await store.write('manifest.json', '{}');
		await expect(store.write('manifest.json', '{}')).rejects.toThrow();
		const { api } = site({});
		await expect(exportAll(api, store, { withAssets: false })).rejects.toMatchObject({
			exitCode: EXIT.usage
		});
		await writeFile(path.join(dir, 'x'), '');
		expect((await readdir(dir)).sort()).toEqual(['manifest.json', 'x']);
	});
});

describe('export', () => {
	const sha = async (s: Uint8Array) =>
		[...new Uint8Array(await crypto.subtle.digest('SHA-256', s as BufferSource))]
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');

	it('writes pages, metadata, verified images and a manifest; the token stays on the site', async () => {
		const image = new Uint8Array([1, 2, 3]);
		const imageId = '22222222-2222-4222-8222-222222222222';
		const { api, calls } = site({
			'GET /api/owner/v1/export/start': () => Response.json({ highWater: 9, pages: 1, assets: 1 }),
			'GET /api/owner/v1/export/pages': () =>
				Response.json({
					pages: [
						{
							id: ID,
							title: '日記',
							format: 'link-text-v1',
							revision: 2,
							source: '本文',
							dailyDate: null,
							createdAt: 'a',
							updatedAt: 'b',
							aliases: ['旧名']
						}
					],
					nextCursor: null
				}),
			'GET /api/owner/v1/export/assets': async () =>
				Response.json({
					assets: [
						{
							id: imageId,
							mime: 'image/png',
							bytes: 3,
							width: 1,
							height: 1,
							sha256: await sha(image),
							url: 'https://media.infixer.link/originals/x.png',
							source: 'upload'
						}
					],
					nextCursor: null
				})
		});
		// The media host is another origin.
		api.download = async (url) => {
			calls.push({ url, method: 'GET', body: undefined, auth: null });
			expect(new URL(url).origin).toBe('https://media.infixer.link');
			return image;
		};
		const store = memoryStore();
		const manifest = await exportAll(api, store, {
			withAssets: true,
			now: () => new Date(0)
		});
		expect([...store.files.keys()].sort()).toEqual([
			'assets-manifest.json',
			`assets/${imageId}.png`,
			'manifest.json',
			`metadata/${ID}.json`,
			`pages/${ID}.link.txt`
		]);
		expect(new TextDecoder().decode(store.files.get(`pages/${ID}.link.txt`))).toBe('本文');
		expect(manifest).toMatchObject({
			highWater: 9,
			pages: 1,
			assets: { listed: 1, downloaded: 1 }
		});
		expect(Object.keys(manifest.files)).toHaveLength(4);
		expect(
			calls.filter((c) => c.url.includes('media.infixer.link')).every((c) => c.auth === null)
		).toBe(true);
	});

	it('refuses an image whose bytes do not match the listed hash', async () => {
		const { api } = site({
			'GET /api/owner/v1/export/start': () => Response.json({ highWater: 1, pages: 0, assets: 1 }),
			'GET /api/owner/v1/export/pages': () => Response.json({ pages: [], nextCursor: null }),
			'GET /api/owner/v1/export/assets': () =>
				Response.json({
					assets: [
						{
							id: ID,
							mime: 'image/png',
							bytes: 1,
							width: 1,
							height: 1,
							sha256: '0'.repeat(64),
							url: '/media/x.png',
							source: 'upload'
						}
					],
					nextCursor: null
				}),
			'GET /media/x.png': () => new Response(new Uint8Array([9]))
		});
		await expect(exportAll(api, memoryStore(), { withAssets: true })).rejects.toThrow('ハッシュ');
	});
});
