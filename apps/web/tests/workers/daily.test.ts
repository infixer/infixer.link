/** POST /api/owner/v1/daily/{date}: get-or-create without duplicates (design §4.1, §8). */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiClient, newPage, resetDb } from '../helpers/api-client';

let owner: ApiClient;

beforeEach(async () => {
	await resetDb();
	owner = new ApiClient();
	await owner.setupOwner();
});

const daily = (date: string) =>
	owner.json(`/api/owner/v1/daily/${date}`, { body: { mutationId: crypto.randomUUID() } });

describe('daily pages', () => {
	it('creates an empty page titled with the date, then returns the same page', async () => {
		const first = await daily('2026-10-15');
		expect(first.status).toBe(201);
		expect(first.body).toMatchObject({
			title: '2026-10-15',
			dailyDate: '2026-10-15',
			created: true,
			revision: 1
		});
		const second = await daily('2026-10-15');
		expect(second.status).toBe(200);
		expect(second.body).toMatchObject({ pageId: first.body.pageId, created: false });
	});

	it('never creates two pages for concurrent requests on the same date', async () => {
		const results = await Promise.all([1, 2, 3, 4].map(() => daily('2026-10-16')));
		expect(new Set(results.map((r) => r.body.pageId)).size).toBe(1);
		expect(results.filter((r) => r.body.created)).toHaveLength(1);
		expect(
			await env.DB.prepare(`SELECT count(*) AS n FROM pages WHERE daily_date = '2026-10-16'`).first(
				'n'
			)
		).toBe(1);
	});

	it('rejects invalid dates and anonymous callers', async () => {
		expect((await daily('2026-02-30')).status).toBe(404);
		expect((await daily('20261015')).status).toBe(404);
		const anon = new ApiClient();
		expect(
			(
				await anon.json('/api/owner/v1/daily/2026-10-15', {
					body: { mutationId: crypto.randomUUID() }
				})
			).status
		).toBe(401);
	});

	it('reports a deleted daily page instead of silently creating a second one', async () => {
		const first = await daily('2026-10-17');
		await owner.json(`/api/owner/v1/pages/${first.body.pageId}`, {
			method: 'DELETE',
			body: { baseRevision: 1, mutationId: crypto.randomUUID() }
		});
		const again = await daily('2026-10-17');
		expect(again.status).toBe(409);
		expect(again.body).toMatchObject({
			code: 'page_deleted',
			details: { pageId: first.body.pageId }
		});
	});

	it('reports a name conflict when a non-daily page already uses the date as title', async () => {
		await owner.json('/api/owner/v1/pages', { body: newPage({ title: '2026-10-18' }) });
		expect((await daily('2026-10-18')).body.code).toBe('name_conflict');
	});
});
