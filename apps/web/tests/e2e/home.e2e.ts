import { expect, test } from '@playwright/test';

const tokyoToday = () =>
	new Intl.DateTimeFormat('en-CA', {
		timeZone: 'Asia/Tokyo',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).format(new Date());

test.describe('SSR without JavaScript', () => {
	test.use({ javaScriptEnabled: false });

	test('renders the page and the JST date on the server', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('h1')).toHaveText('infixer.link');
		await expect(page.getByTestId('today')).toHaveText(tokyoToday());
		await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
	});
});

test('health endpoint reports D1 and is not cacheable', async ({ request }) => {
	const res = await request.get('/api/health');
	expect(res.status()).toBe(200);
	expect(res.headers()['cache-control']).toBe('no-store');
	expect(await res.json()).toMatchObject({ status: 'ok', db: 'ok', temporal: 'polyfill' });
});

test('page fits a phone viewport without horizontal scroll', async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 667 });
	await page.goto('/');
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(0);
});
