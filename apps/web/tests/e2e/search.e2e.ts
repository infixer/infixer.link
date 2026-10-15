/** Phase 5: search page (design §11.1, ADR 0013). */
import { expect, test, type Page } from '@playwright/test';
import { createPage, ownerContext } from './helpers';

/** ASCII token (FTS path) unique to this test run. */
const token = () => `kw${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;

async function seed(browser: import('@playwright/test').Browser, title: string, source: string) {
	const owner = await ownerContext(browser);
	const created = await createPage(owner.request, title, source);
	await owner.close();
	return created;
}

const results = (page: Page) => page.getByTestId('search-results');

/** Opens /search and waits for hydration (the box is focused on mount). */
async function openSearch(page: Page) {
	await page.goto('/search');
	await expect(page.getByTestId('search-input')).toBeFocused();
}

test.describe('without JavaScript', () => {
	test.use({ javaScriptEnabled: false });

	test('the form and results work as plain HTML', async ({ browser, page }) => {
		const t = token();
		await seed(browser, `検索ページ ${t}`, `本文の中に ${t} がある`);

		await page.goto('/search');
		await page.getByTestId('search-input').fill(t);
		await page.getByTestId('search-input').press('Enter');
		await expect(page).toHaveURL(new RegExp(`/search\\?q=${t}$`));
		await expect(results(page).locator('li')).toHaveCount(1);
		await expect(results(page)).toContainText(`検索ページ ${t}`);
		await expect(results(page).locator('mark').first()).toHaveText(t);
		await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
	});
});

test('searches while typing and keeps the URL in sync', async ({ browser, page }) => {
	const t = token();
	await seed(browser, `日本語の${t}`, '鰻と鱧の話');

	await openSearch(page);
	await page.getByTestId('search-input').fill(t);
	await expect(results(page)).toContainText(`日本語の${t}`);
	await expect(page).toHaveURL(new RegExp(`/search\\?q=${t}$`));

	// One and two characters use the LIKE fallback.
	await page.getByTestId('search-input').fill(`鱧 ${t}`);
	await expect(results(page).locator('li')).toHaveCount(1);
	await page.getByTestId('search-input').fill(`鰻と ${t}`);
	await expect(results(page).locator('li')).toHaveCount(1);
	await page.getByTestId('search-input').fill(`鯛 ${t}`);
	await expect(page.getByTestId('search-status')).toContainText('見つかりませんでした');
});

test('an older, slower response never replaces newer results', async ({ browser, page }) => {
	const t = token();
	await seed(browser, `新しい方 ${t}`, '');
	const slow = `${t}x`;
	let releaseSlow!: () => void;
	const slowGate = new Promise<void>((r) => (releaseSlow = r));
	await page.route('**/api/public/v1/search?*', async (route) => {
		if (new URL(route.request().url()).searchParams.get('q') === slow) {
			await slowGate;
			await route.continue().catch(() => {});
		} else {
			await route.continue();
		}
	});

	await openSearch(page);
	const slowRequest = page.waitForRequest((r) => r.url().includes(`q=${slow}`));
	await page.getByTestId('search-input').fill(slow);
	await slowRequest;
	await page.getByTestId('search-input').fill(t);
	await expect(results(page)).toContainText(`新しい方 ${t}`);

	releaseSlow();
	await page.waitForTimeout(300);
	await expect(results(page)).toContainText(`新しい方 ${t}`);
	await expect(page).toHaveURL(new RegExp(`q=${t}$`));
});

test('arrow keys move through results and Enter opens one', async ({ browser, page }) => {
	const t = token();
	await seed(browser, `一つ目 ${t}`, '');
	await seed(browser, `二つ目 ${t}`, '');

	await openSearch(page);
	await page.getByTestId('search-input').fill(t);
	await expect(results(page).locator('li')).toHaveCount(2);
	const links = results(page).locator('a.hit');

	await page.keyboard.press('ArrowDown');
	await expect(links.nth(0)).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(links.nth(1)).toBeFocused();
	await page.keyboard.press('ArrowUp');
	await page.keyboard.press('ArrowUp');
	await expect(page.getByTestId('search-input')).toBeFocused();
	await page.keyboard.press('ArrowDown');
	const title = await links.nth(0).locator('.title').textContent();
	await page.keyboard.press('Enter');
	await expect(page.locator('h1')).toHaveText(title!);
});

test('does not search during IME composition (Chromium CDP)', async ({ page, browserName }) => {
	test.skip(browserName !== 'chromium', 'IME emulation uses the Chrome DevTools Protocol');
	const searched: string[] = [];
	page.on('request', (r) => {
		if (r.url().includes('/api/public/v1/search')) {
			searched.push(new URL(r.url()).searchParams.get('q') ?? '');
		}
	});
	await openSearch(page);
	const cdp = await page.context().newCDPSession(page);
	await page.getByTestId('search-input').focus();
	for (const text of ['ど', 'どく', 'どくしょ']) {
		await cdp.send('Input.imeSetComposition', {
			text,
			selectionStart: text.length,
			selectionEnd: text.length
		});
	}
	await page.waitForTimeout(500);
	expect(searched).toEqual([]);

	await cdp.send('Input.insertText', { text: '読書' });
	await expect.poll(() => searched).toEqual(['読書']);
});

test('the header links to search and still fits a phone for the owner', async ({ browser }) => {
	const owner = await ownerContext(browser, { viewport: { width: 375, height: 667 } });
	const page = await owner.newPage();
	await page.goto('/');
	await expect(page.getByTestId('new-page')).toBeVisible();
	await page.getByTestId('nav-search').click();
	await expect(page).toHaveURL(/\/search$/);
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(0);
	await owner.close();
});
