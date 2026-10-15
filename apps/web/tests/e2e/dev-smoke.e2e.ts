/**
 * `pnpm dev` smoke test: styles apply and the CSP blocks nothing. The dev server's CSP
 * uses 'unsafe-inline' for Vite-injected styles; adding a nonce there would block them all.
 */
import { expect, test } from '@playwright/test';

for (const scheme of ['light', 'dark'] as const) {
	test(`dev server renders with styles and no CSP errors (${scheme})`, async ({ page }) => {
		await page.emulateMedia({ colorScheme: scheme });
		const cspErrors: string[] = [];
		page.on('console', (m) => {
			if (m.type() === 'error' && /Content Security Policy/i.test(m.text()))
				cspErrors.push(m.text());
		});
		await page.goto('/', { waitUntil: 'load' });
		const header = page.getByTestId('site-header');
		await expect(header).toHaveCSS('position', 'fixed');
		await expect(header).toHaveCSS(
			'background-color',
			/oklch\(0\.269 0 0\)|rgb\(3[0-9], 3[0-9], 3[0-9]\)/
		);
		await expect(page.locator('main')).toHaveCSS('max-width', /px$/);
		expect(cspErrors).toEqual([]);
	});
}
