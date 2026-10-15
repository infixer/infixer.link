/**
 * Phase 3: rendering, live preview, links, completion, cards and related pages
 * (design §6, §11.2, ADR 0009, ADR 0010).
 */
import { expect, test, type Page } from '@playwright/test';
import { BASE, createPage, getOwnerPage, ownerContext, unique } from './helpers';

const saveState = (page: Page) => page.getByTestId('save-state');

async function editorReady(page: Page) {
	await expect(page.getByTestId('editor')).toBeVisible();
	await expect(page.locator('.cm-content')).toBeVisible();
}

/** Puts the cursor at the end of the document (so earlier lines are "not active"). */
async function cursorToEnd(page: Page) {
	await page.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+End');
}

test('read view renders headings, lists, emphasis, links, tags and code safely', async ({
	browser
}) => {
	const owner = await ownerContext(browser);
	const target = unique('リンク先');
	await createPage(owner.request, target, '');
	const title = unique('記法');
	const { pageId } = await createPage(
		owner.request,
		title,
		[
			'# 見出し',
			`- [${target}] を読んだ`,
			' - **太字** と [* 強調] と ~~取消~~',
			'#タグ と [まだないページ]',
			'`[コード内]` と [資料](https://example.org/doc)',
			'<script>window.__xss = 1</script> [x](javascript:alert(1))'
		].join('\n')
	);

	const anon = await (await browser.newContext()).newPage();
	await anon.goto(`/p/${pageId}/x`);
	const body = anon.getByTestId('page-source');
	await expect(body.locator('.ln.h1')).toHaveText('見出し');
	await expect(body.locator('.ln.bul')).toHaveCount(2);
	await expect(body.locator('strong').first()).toHaveText('太字');
	await expect(body.getByRole('link', { name: target })).toHaveAttribute(
		'href',
		new RegExp(`^/p/[0-9a-f-]{36}/`)
	);
	await expect(body.getByRole('link', { name: 'まだないページ' })).toHaveClass(/missing/);
	await expect(body.getByRole('link', { name: '#タグ' })).toBeVisible();
	await expect(body.locator('code.ic')).toHaveText('[コード内]');
	await expect(body.getByRole('link', { name: '資料' })).toHaveAttribute(
		'href',
		'https://example.org/doc'
	);
	// Raw HTML is text; javascript: never becomes a link target.
	await expect(body).toContainText('<script>window.__xss = 1</script>');
	expect(
		await anon.evaluate(() => (window as unknown as { __xss?: number }).__xss)
	).toBeUndefined();
	expect(await anon.locator('a[href^="javascript:"]').count()).toBe(0);
});

test.describe('editor (Chromium)', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'editor interactions run once');

	test('non-active lines look rendered; the cursor line shows raw syntax', async ({ browser }) => {
		const owner = await ownerContext(browser);
		const { pageId } = await createPage(owner.request, unique('ライブ'), '**太字** の行\n二行目');
		const page = await owner.newPage();
		await page.goto(`/p/${pageId}/x`);
		await editorReady(page);
		const firstLine = page.locator('.cm-line').first();
		await expect(firstLine).toHaveText('太字 の行'); // markers hidden
		await expect(firstLine.locator('.b')).toHaveText('太字');
		await page.locator('.cm-line').nth(1).click();
		await page.keyboard.press('ArrowUp');
		await expect(firstLine).toHaveText('**太字** の行'); // raw while editing
	});

	test('clicking a link on another line navigates; a missing page can be created', async ({
		browser
	}) => {
		const owner = await ownerContext(browser);
		const missing = unique('新しい話題');
		const { pageId } = await createPage(
			owner.request,
			unique('リンク元'),
			`[${missing}] について\n最後の行`
		);
		const page = await owner.newPage();
		await page.goto(`/p/${pageId}/x`);
		await editorReady(page);
		await cursorToEnd(page);
		await page.locator('.cm-line').first().getByText(missing).click();
		await expect(page).toHaveURL(new RegExp(`/t/${encodeURIComponent(missing)}$`));
		await expect(page.getByTestId('missing-page')).toBeVisible();
		await page.getByTestId('create-missing').click();
		await expect(page).toHaveURL(/\/p\/[0-9a-f-]{36}\//);
		await editorReady(page);
		await expect(page.getByLabel('タイトル')).toHaveValue(missing);
		// The new page lists the page that links to it.
		await page.reload();
		await expect(page.getByTestId('related')).toContainText('リンク元');
	});

	test('[ completes page titles and Enter continues a list', async ({ browser }) => {
		const owner = await ownerContext(browser);
		const target = unique('補完される本');
		await createPage(owner.request, target, '');
		const { pageId } = await createPage(owner.request, unique('補完'), '');
		const page = await owner.newPage();
		await page.goto(`/p/${pageId}/x`);
		await editorReady(page);
		await page.locator('.cm-content').click();
		// Type enough of the unique title that the target is the first suggestion on every run.
		await page.keyboard.type(`- [${target.slice(0, -2)}`);
		const option = page.locator('.cm-tooltip-autocomplete li', { hasText: target });
		await expect(option).toBeVisible();
		await page.waitForTimeout(150); // CodeMirror ignores accept keys right after the popup opens
		await page.keyboard.press('Enter');
		await page.keyboard.press('Enter'); // continues the list
		await page.keyboard.type('次の項目');
		await expect(saveState(page)).toHaveText('公開済み', { timeout: 10_000 });
		expect((await getOwnerPage(owner.request, pageId)).source).toBe(`- [${target}]\n- 次の項目`);
	});

	test('a URL-only line becomes a link card for the owner and for visitors', async ({
		browser
	}) => {
		const owner = await ownerContext(browser);
		const cardTitle = unique('カードになるページ');
		const target = await createPage(owner.request, cardTitle, 'カードの説明文です');
		const url = `${BASE}/p/${target.pageId}/card`;
		const { pageId } = await createPage(owner.request, unique('カード'), `${url}\n最後の行`);

		const page = await owner.newPage();
		await page.goto(`/p/${pageId}/x`);
		await editorReady(page);
		await cursorToEnd(page);
		// The editor asks the server for the preview (owner-only) and shows the card.
		const card = page.locator('.cm-content .card');
		await expect(card).toContainText(cardTitle, { timeout: 15_000 });
		await expect(card).toContainText('カードの説明文です');

		const anon = await (await browser.newContext()).newPage();
		await anon.goto(`/p/${pageId}/x`);
		await expect(anon.getByTestId('page-source').locator('.card')).toContainText(cardTitle);
		await expect(anon.getByTestId('page-source').locator('.card')).toHaveAttribute('href', url);
	});
});

test('related pages show backlinks and pages sharing a link', async ({ browser }) => {
	const owner = await ownerContext(browser);
	const hub = unique('共通の話題');
	const hubPage = await createPage(owner.request, hub, '');
	const a = await createPage(owner.request, unique('A'), `[${hub}]`);
	const bTitle = unique('B');
	await createPage(owner.request, bTitle, `#${hub.replace(' ', '_')} [${hub}]`);

	const anon = await (await browser.newContext()).newPage();
	await anon.goto(`/p/${a.pageId}/x`);
	await expect(anon.getByTestId('related')).toContainText(bTitle);
	await anon.goto(`/p/${hubPage.pageId}/x`);
	await expect(anon.getByTestId('related')).toContainText(bTitle);
});
