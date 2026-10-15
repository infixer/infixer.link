/**
 * Phase 4: image upload, paste, held publishing, resume after reload, rejection,
 * public rendering and link-card images (design §10, ADR 0012).
 */
import { expect, test, type Page } from '@playwright/test';
import { pngBytes } from '../helpers/images';
import { BASE, createPage, getOwnerPage, ownerContext, unique } from './helpers';

test.skip(({ browserName }) => browserName !== 'chromium', 'upload flows run once (Chromium)');

const saveState = (page: Page) => page.getByTestId('save-state');
const png = (variant: number) => ({
	name: `photo-${variant}.png`,
	mimeType: 'image/png',
	buffer: Buffer.from(pngBytes(variant))
});

async function openOwnerPage(browser: import('@playwright/test').Browser, source = '最初の行') {
	const owner = await ownerContext(browser);
	const { pageId } = await createPage(owner.request, unique('画像'), source);
	const page = await owner.newPage();
	await page.goto(`/p/${pageId}/x`);
	await expect(page.locator('.cm-content')).toBeVisible();
	return { owner, page, pageId };
}

async function cursorToEnd(page: Page) {
	await page.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+End');
}

test('choosing a photo uploads it, then the page and the public view show the image', async ({
	browser
}) => {
	const { owner, page, pageId } = await openOwnerPage(browser);
	await cursorToEnd(page);
	await page.getByTestId('image-input').setInputFiles(png(101));
	await expect(page.getByText('画像は原本のまま公開されます')).toBeVisible();
	await expect(saveState(page)).toHaveText('公開済み', { timeout: 15_000 });

	const source: string = (await getOwnerPage(owner.request, pageId)).source;
	const id = /\[asset:([0-9a-f-]{36})\]/.exec(source)?.[1];
	expect(id).toBeTruthy();
	expect(source).toBe(`最初の行\n[asset:${id}]`);

	// Editor shows the uploaded image on non-active lines.
	await page.locator('.cm-line').first().click();
	await expect(page.locator('.cm-content img.img')).toHaveAttribute(
		'src',
		/^\/media\/originals\/[0-9a-f]{64}\.png$/
	);

	const anon = await (await browser.newContext()).newPage();
	await anon.goto(`/p/${pageId}/x`);
	const img = anon.getByTestId('page-source').locator('img.img');
	await expect(img).toHaveAttribute('width', '1');
	await expect(img).toHaveAttribute('height', '1');
	expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1);
	// OGP image for this page.
	await expect(anon.locator('meta[property="og:image"]')).toHaveAttribute(
		'content',
		new RegExp(`^${BASE}/media/originals/`)
	);
});

test('pasting an image inserts it at the cursor', async ({ browser }) => {
	const { owner, page, pageId } = await openOwnerPage(browser, '');
	await page.locator('.cm-content').click();
	const b64 = Buffer.from(pngBytes(102)).toString('base64');
	await page.evaluate((data) => {
		const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
		const dt = new DataTransfer();
		dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
		document
			.querySelector('.cm-content')!
			.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
			);
	}, b64);
	await expect(saveState(page)).toHaveText('公開済み', { timeout: 15_000 });
	expect((await getOwnerPage(owner.request, pageId)).source).toMatch(/^\[asset:[0-9a-f-]{36}\]$/);
});

test('text is not published while its image is still uploading; failures can be retried', async ({
	browser
}) => {
	const { owner, page, pageId } = await openOwnerPage(browser);
	let block = true;
	await page.route('**/api/owner/v1/assets/*', (route) =>
		block && route.request().method() === 'PUT'
			? route.abort('internetdisconnected')
			: route.continue()
	);
	await cursorToEnd(page);
	await page.keyboard.type('\n画像の前の文');
	await page.getByTestId('image-input').setInputFiles(png(103));
	await expect(page.getByRole('alert')).toContainText('画像を送信できませんでした', {
		timeout: 10_000
	});
	await expect(saveState(page)).toHaveText('画像を送信中（端末に保存済み）');
	expect((await getOwnerPage(owner.request, pageId)).source).toBe('最初の行'); // held locally

	block = false;
	await page.getByRole('button', { name: '再送信' }).click();
	await expect(saveState(page)).toHaveText('公開済み', { timeout: 15_000 });
	expect((await getOwnerPage(owner.request, pageId)).source).toMatch(
		/^最初の行\n画像の前の文\n\[asset:[0-9a-f-]{36}\]$/
	);
});

test('removing a failed image publishes the text', async ({ browser }) => {
	const { owner, page, pageId } = await openOwnerPage(browser);
	await page.route('**/api/owner/v1/assets/*', (route) => route.abort('internetdisconnected'));
	await cursorToEnd(page);
	await page.getByTestId('image-input').setInputFiles(png(104));
	await expect(page.getByRole('alert')).toBeVisible({ timeout: 10_000 });
	await page.getByRole('button', { name: '画像を外す' }).click();
	await expect(page.locator('.cm-content')).not.toContainText('[asset:');
	await cursorToEnd(page);
	await page.keyboard.type('文だけ');
	await expect(saveState(page)).toHaveText('公開済み', { timeout: 15_000 });
	expect((await getOwnerPage(owner.request, pageId)).source).toBe('最初の行文だけ');
});

test('an interrupted upload resumes after a reload', async ({ browser }) => {
	const { owner, page, pageId } = await openOwnerPage(browser);
	await page.route('**/api/owner/v1/assets/*', (route) => route.abort('internetdisconnected'));
	await cursorToEnd(page);
	await page.getByTestId('image-input').setInputFiles(png(105));
	await expect(saveState(page)).toHaveText('画像を送信中（端末に保存済み）', { timeout: 10_000 });
	await page.unroute('**/api/owner/v1/assets/*');
	await page.reload();
	await expect(saveState(page)).toHaveText('公開済み', { timeout: 15_000 });
	expect((await getOwnerPage(owner.request, pageId)).source).toMatch(/\[asset:[0-9a-f-]{36}\]$/);
});

test('unsupported formats are refused with a clear message and nothing is inserted', async ({
	browser
}) => {
	const { page } = await openOwnerPage(browser);
	await cursorToEnd(page);
	await page.getByTestId('image-input').setInputFiles({
		name: 'IMG_0001.HEIC',
		mimeType: 'image/heic',
		buffer: Buffer.from([0, 0, 0, 0x18, ...Buffer.from('ftypheic'), 0, 0, 0, 0])
	});
	await expect(page.getByText('HEIC / AVIF にはまだ対応していません')).toBeVisible();
	await expect(page.locator('.cm-content')).not.toContainText('[asset:');
});

test('a link card shows the linked page image copied into media', async ({ browser }) => {
	const { owner, page: first } = await openOwnerPage(browser);
	await cursorToEnd(first);
	await first.getByTestId('image-input').setInputFiles(png(106));
	await expect(saveState(first)).toHaveText('公開済み', { timeout: 15_000 });
	const target = first.url().replace(/\/x$/, '/card');

	const { pageId } = await createPage(owner.request, unique('カード画像'), `${target}\n最後の行`);
	const page = await owner.newPage();
	await page.goto(`/p/${pageId}/x`);
	await page.locator('.cm-line').last().click();
	await expect(page.locator('.cm-content .card img.card-image')).toHaveAttribute(
		'src',
		/^\/media\/originals\/[0-9a-f]{64}\.png$/,
		{ timeout: 15_000 }
	);
	const anon = await (await browser.newContext()).newPage();
	await anon.goto(`/p/${pageId}/x`);
	await expect(
		anon.getByTestId('page-source').locator('.card.has-image img.card-image')
	).toBeVisible();
});
