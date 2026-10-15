/**
 * Phase 5: lab CLS / LCP of a public page with images (design §12.2).
 * Local wrangler dev, Chromium, no CPU / network throttling except a delayed image
 * response, so the image always arrives after the first layout (worst case for CLS).
 */
import { expect, test } from '@playwright/test';
import { createPage, ownerContext, solidPng, unique, uploadImage } from './helpers';

test.skip(({ browserName }) => browserName !== 'chromium', 'lab vitals are measured in Chromium');

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
