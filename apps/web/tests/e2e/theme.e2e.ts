/** Dark mode and theme switch (ADR 0011), visible editor caret. */
import { expect, test } from '@playwright/test';
import { createPage, ownerContext, unique } from './helpers';

const htmlClass = (page: import('@playwright/test').Page) =>
	page.evaluate(() => document.documentElement.className);

test.describe('follows the OS by default', () => {
	test.use({ colorScheme: 'dark' });

	test('dark OS → dark theme before first paint, without CSP errors', async ({ page }) => {
		const cspErrors: string[] = [];
		page.on(
			'console',
			(m) =>
				m.type() === 'error' &&
				/Content Security Policy/i.test(m.text()) &&
				cspErrors.push(m.text())
		);
		await page.goto('/', { waitUntil: 'commit' });
		await page.waitForSelector('html.dark', { state: 'attached' });
		await page.waitForLoadState('networkidle');
		expect(await htmlClass(page)).toContain('dark');
		const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
		expect(bg).not.toBe('rgb(255, 255, 255)');
		expect(cspErrors).toEqual([]);
	});
});

test('switch: fix dark, persist across reload, press again to follow the system', async ({
	page
}) => {
	await page.emulateMedia({ colorScheme: 'light' });
	await page.goto('/');
	expect(await htmlClass(page)).toContain('light');
	const dark = page.getByTestId('theme-switch').locator('[data-theme-value="dark"]');
	await dark.click();
	await expect(dark).toHaveAttribute('aria-pressed', 'true');
	expect(await htmlClass(page)).toContain('dark');

	await page.reload();
	expect(await htmlClass(page)).toContain('dark');
	await expect(dark).toHaveAttribute('aria-pressed', 'true');

	await dark.click(); // back to "system" (light)
	await expect(dark).toHaveAttribute('aria-pressed', 'false');
	expect(await htmlClass(page)).toContain('light');
	expect(await page.evaluate(() => localStorage.getItem('theme'))).toBeNull();
});

test('header is fixed and does not cover the content', async ({ page }) => {
	await page.goto('/');
	const header = await page.getByTestId('site-header').boundingBox();
	const main = await page.locator('main').boundingBox();
	expect(main!.y).toBeGreaterThanOrEqual(header!.y + header!.height - 1);
});

test.describe('editor caret (Chromium)', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'caret drawing checked once');

	for (const scheme of ['light', 'dark'] as const) {
		test(`caret is visible in ${scheme} mode`, async ({ browser }) => {
			const owner = await ownerContext(browser, { colorScheme: scheme });
			const { pageId } = await createPage(owner.request, unique('カーソル'), '本文');
			const page = await owner.newPage();
			const cspErrors: string[] = [];
			page.on('console', (m) => {
				if (m.type() === 'error' && /Content Security Policy/i.test(m.text()))
					cspErrors.push(m.text());
			});
			await page.goto(`/p/${pageId}/x`);
			await page.locator('.cm-content').click();
			await page.keyboard.press('End');
			const caret = page.locator('.cm-cursor').first();
			await expect(caret).toBeAttached();
			// The caret is drawn where the text is (CodeMirror's base styles are not blocked by CSP).
			const [caretBox, lineBox, textEnd] = await page.evaluate(() => {
				const rect = (el: Element) => el.getBoundingClientRect().toJSON();
				const range = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
				return [
					rect(document.querySelector('.cm-cursor')!),
					rect(document.querySelector('.cm-line')!),
					range.left
				];
			});
			expect(caretBox.top).toBeGreaterThanOrEqual(lineBox.top - 1);
			expect(caretBox.top + caretBox.height).toBeLessThanOrEqual(lineBox.bottom + 1);
			expect(Math.abs(caretBox.left - textEnd)).toBeLessThanOrEqual(3);
			expect(cspErrors).toEqual([]);
			const style = await caret.evaluate((el) => {
				const s = getComputedStyle(el);
				return {
					color: s.borderLeftColor,
					width: s.borderLeftWidth,
					bg: getComputedStyle(document.body).backgroundColor
				};
			});
			expect(style.width).toBe('2px');
			expect(style.color).not.toBe(style.bg);
			// Dark mode: a light caret; light mode: a dark caret.
			// Lightness 0–100: oklch(L% ...) or the average of rgb() channels.
			const nums = style.color.match(/[\d.]+/g)!.map(Number);
			// Chrome serialises oklch lightness as 0–1 (or a percentage).
			const lightness = style.color.startsWith('oklch')
				? nums[0] <= 1
					? nums[0] * 100
					: nums[0]
				: ((nums[0] + nums[1] + nums[2]) / 3 / 255) * 100;
			if (scheme === 'dark') expect(lightness).toBeGreaterThan(80);
			else expect(lightness).toBeLessThan(35);
		});
	}
});
