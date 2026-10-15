/**
 * Phase 5: lab CLS / LCP of a public page with images (design §12.2).
 * Local wrangler dev, Chromium, no CPU / network throttling except a delayed image
 * response, so the image always arrives after the first layout (worst case for CLS).
 */
import { deflateSync, crc32 } from 'node:zlib';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { BASE, createPage, csrfToken, ownerContext, unique } from './helpers';

test.skip(({ browserName }) => browserName !== 'chromium', 'lab vitals are measured in Chromium');

/** A valid solid-color RGB PNG of the given size. */
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
		const out = Buffer.alloc(body.length + 8);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(crc32(body), body.length + 4);
		return out;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8; // bit depth
	header[9] = 2; // RGB
	const row = Buffer.alloc(1 + width * 3);
	for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
	const raw = Buffer.concat(Array.from({ length: height }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0))
	]);
}

async function uploadImage(request: APIRequestContext, png: Buffer): Promise<string> {
	const id = crypto.randomUUID();
	const headers = { origin: BASE, 'x-csrf-token': await csrfToken(request) };
	const put = await request.put(`/api/owner/v1/assets/${id}`, {
		data: png,
		headers: { ...headers, 'content-type': 'image/png' }
	});
	expect(put.status()).toBe(200);
	const done = await request.post(`/api/owner/v1/assets/${id}/complete`, { headers });
	expect(done.status()).toBe(200);
	return id;
}

test('a public page with images has no layout shift while images load', async ({ browser }) => {
	const owner = await ownerContext(browser);
	const seed = Math.floor(Math.random() * 200);
	const first = await uploadImage(owner.request, solidPng(1600, 1000, [seed, 120, 200]));
	const second = await uploadImage(owner.request, solidPng(800, 1200, [200, seed, 90]));
	const text = '画像のあとにも文章が続く。'.repeat(8);
	const { pageId } = await createPage(
		owner.request,
		unique('画像の日記'),
		['朝の写真', `[asset:${first}]`, text, `[asset:${second}]`, text].join('\n')
	);
	await owner.close();

	const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
	const page = await context.newPage();
	await page.route('**/media/**', async (route) => {
		await new Promise((r) => setTimeout(r, 800));
		await route.continue();
	});
	await page.addInitScript(() => {
		const w = window as unknown as { __cls: number; __lcp: number };
		w.__cls = 0;
		w.__lcp = 0;
		new PerformanceObserver((list) => {
			for (const e of list.getEntries() as (PerformanceEntry & {
				value: number;
				hadRecentInput: boolean;
			})[]) {
				if (!e.hadRecentInput) w.__cls += e.value;
			}
		}).observe({ type: 'layout-shift', buffered: true });
		new PerformanceObserver((list) => {
			w.__lcp = list.getEntries().at(-1)!.startTime;
		}).observe({ type: 'largest-contentful-paint', buffered: true });
	});

	await page.goto(`/p/${pageId}/x`);
	const images = page.locator('[data-testid="page-source"] img.img');
	await expect(images).toHaveCount(2);
	// The first image is above the fold: loaded eagerly with high priority; the rest lazily.
	await expect(images.nth(0)).toHaveAttribute('loading', 'eager');
	await expect(images.nth(1)).toHaveAttribute('loading', 'lazy');
	await expect.poll(() => images.nth(0).evaluate((i: HTMLImageElement) => i.complete)).toBe(true);
	await page.mouse.wheel(0, 3000);
	await expect.poll(() => images.nth(1).evaluate((i: HTMLImageElement) => i.complete)).toBe(true);
	await page.waitForTimeout(300);

	const { cls, lcp } = await page.evaluate(() => {
		const w = window as unknown as { __cls: number; __lcp: number };
		return { cls: w.__cls, lcp: w.__lcp };
	});
	console.log(`lab CLS ${cls.toFixed(3)}, LCP ${lcp.toFixed(0)}ms (image delayed 800ms)`);
	expect(cls).toBeLessThanOrEqual(0.1);
	await context.close();
});
