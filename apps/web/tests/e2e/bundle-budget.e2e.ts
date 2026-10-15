import { gzipSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// Design §12.2: public first-load JS (gzip) <= 50 KiB.
const PUBLIC_JS_BUDGET = 50 * 1024;

for (const route of ['/', '/search']) {
	test(`@perf public first-load JS stays within budget (${route})`, async ({ page }) => {
		const scripts = new Map<string, number>();
		const ownerOnly: string[] = [];
		page.on('response', async (response) => {
			const url = response.url();
			if (response.request().resourceType() !== 'script' && !url.endsWith('.js')) return;
			try {
				const body = await response.body();
				scripts.set(url, gzipSync(body).length);
				// Passkey (WebAuthn) code must only load on owner screens (design §9.1, §9.3).
				if (body.toString('utf8').includes('navigator.credentials')) ownerOnly.push(url);
			} catch {
				// body unavailable (e.g. redirect); ignore
			}
		});

		await page.goto(route, { waitUntil: 'networkidle' });

		const total = [...scripts.values()].reduce((a, b) => a + b, 0);
		const report = {
			route,
			measuredAt: new Date().toISOString(),
			budgetBytes: PUBLIC_JS_BUDGET,
			totalGzipBytes: total,
			files: Object.fromEntries(
				[...scripts].map(([url, size]) => [new URL(url).pathname, size]).sort()
			)
		};
		mkdirSync('test-results', { recursive: true });
		const name = route === '/' ? 'public' : `public${route.replaceAll('/', '-')}`;
		writeFileSync(`test-results/bundle-${name}.json`, JSON.stringify(report, null, 2));
		console.log(
			`${route} first-load JS: ${(total / 1024).toFixed(1)} KiB gzip (${scripts.size} files)`
		);

		expect(scripts.size).toBeGreaterThan(0);
		expect(total).toBeLessThanOrEqual(PUBLIC_JS_BUDGET);
		expect(ownerOnly).toEqual([]);
	});
}
