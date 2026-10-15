/**
 * Phase 2: same-URL editing, autosave, drafts, conflicts, auth expiry, daily pages,
 * deletion and input performance (design §4, §14.2).
 */
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { BASE, createPage, getOwnerPage, ownerContext, unique, updatePage } from './helpers';

/** For the owner the editor replaces the read view by itself; there is no edit button. */
async function openEditor(page: Page) {
	await expect(page.getByTestId('editor')).toBeVisible();
	await expect(page.locator('.cm-content')).toBeVisible();
}

async function typeInBody(page: Page, text: string) {
	await page.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type(text);
}

const saveState = (page: Page) => page.getByTestId('save-state');

test('owner edits in place: URL never changes and the public page shows the result', async ({
	browser
}) => {
	const owner = await ownerContext(browser);
	const title = unique('編集テスト');
	const { pageId } = await createPage(owner.request, title, '最初の行');
	const page = await owner.newPage();
	const urls: string[] = [];
	page.on('framenavigated', (f) => f === page.mainFrame() && urls.push(f.url()));
	await page.goto(`/p/${pageId}/x`);
	const url = page.url();

	await openEditor(page);
	await typeInBody(page, '\n 追記した行');
	await expect(saveState(page)).toHaveText('公開済み', { timeout: 10_000 });
	expect(page.url()).toBe(url);
	expect(new Set(urls)).toEqual(new Set([url]));

	const anon = await (await browser.newContext()).newPage();
	await anon.goto(`/p/${pageId}/x`);
	await expect(anon.getByTestId('page-source')).toContainText('追記した行');
});

test('no edit button: the read view turns into the editor in place, without moving', async ({
	browser
}) => {
	const owner = await ownerContext(browser);
	const { pageId } = await createPage(owner.request, unique('その場で編集'), '一行目\n二行目');
	const page = await owner.newPage();
	await page.route('**/_app/immutable/**', async (route) => {
		// Hold the editor chunk briefly so the read view can be measured first.
		await new Promise((r) => setTimeout(r, 300));
		await route.continue();
	});
	await page.goto(`/p/${pageId}/x`);
	const readTitle = await page.locator('article h1').boundingBox();
	const readLine = await page.locator('article .ln').first().boundingBox();
	await openEditor(page);
	await expect(page.getByTestId('edit')).toHaveCount(0);
	await expect(page.getByRole('button', { name: '完了' })).toHaveCount(0);
	const editTitle = await page.getByLabel('タイトル').boundingBox();
	const editLine = await page.locator('.cm-line').first().boundingBox();
	expect(Math.abs(editTitle!.y - readTitle!.y)).toBeLessThanOrEqual(1);
	expect(Math.abs(editLine!.y - readLine!.y)).toBeLessThanOrEqual(1);
	expect(Math.abs(editLine!.x - readLine!.x)).toBeLessThanOrEqual(1);

	// A click lands directly in the text.
	await page.locator('.cm-line').nth(1).click();
	await page.keyboard.press('End');
	await page.keyboard.type('！');
	await expect(saveState(page)).toHaveText('公開済み', { timeout: 10_000 });
	expect((await getOwnerPage(owner.request, pageId)).source).toBe('一行目\n二行目！');
});

test('新規 creates a page and puts the cursor in its title', async ({ browser }) => {
	const owner = await ownerContext(browser);
	const page = await owner.newPage();
	await page.goto('/');
	await page.getByTestId('new-page').click();
	await expect(page).toHaveURL(/\/p\/[0-9a-f-]{36}\//);
	const titleInput = page.getByLabel('タイトル');
	await expect(titleInput).toBeFocused();
	await expect(titleInput).toHaveValue(/^無題 /);
	const name = unique('新しいページ');
	await page.keyboard.type(name); // replaces the selected placeholder title
	await page.keyboard.press('Tab');
	await expect(saveState(page)).toHaveText('公開済み', { timeout: 10_000 });
	const id = page.url().split('/')[4];
	expect((await getOwnerPage(owner.request, id)).title).toBe(name);

	const anon = await (await browser.newContext()).newPage();
	await anon.goto('/');
	await expect(anon.getByTestId('new-page')).toHaveCount(0);
});

test.describe('chromium-only scenarios', () => {
	test.skip(
		({ browserName }) => browserName !== 'chromium',
		'network routing and timing checks run once'
	);

	test('unsent edits survive a reload and are sent later', async ({ browser }) => {
		const owner = await ownerContext(browser);
		const { pageId } = await createPage(owner.request, unique('下書き'), 'base');
		const page = await owner.newPage();
		await page.goto(`/p/${pageId}/x`);
		await openEditor(page);
		await page.route(`**/api/owner/v1/pages/${pageId}`, (route) =>
			route.request().method() === 'PUT' ? route.abort('internetdisconnected') : route.continue()
		);
		await typeInBody(page, ' オフラインで書いた');
		await expect(saveState(page)).toHaveText('オフライン（端末に保存済み）', { timeout: 10_000 });
		expect((await getOwnerPage(owner.request, pageId)).source).toBe('base');

		await page.reload();
		await page.unroute(`**/api/owner/v1/pages/${pageId}`);
		await openEditor(page);
		// Sent either by the restored editor or, since Phase 6, by the background outbox
		// sync that runs before the editor reads its draft (ADR 0015).
		await expect(page.locator('.cm-content')).toContainText('オフラインで書いた');
		await expect(saveState(page)).toHaveText('公開済み', { timeout: 10_000 });
		expect((await getOwnerPage(owner.request, pageId)).source).toBe('base オフラインで書いた');
	});

	test('a newer version from another device is never overwritten silently', async ({ browser }) => {
		const owner = await ownerContext(browser);
		const title = unique('競合');
		const { pageId } = await createPage(owner.request, title, 'v1');
		const page = await owner.newPage();
		await page.goto(`/p/${pageId}/x`);
		await openEditor(page);

		// "Another device" saves first.
		expect((await updatePage(owner.request, pageId, 1, title, 'other device')).status()).toBe(200);
		await typeInBody(page, ' mine');
		await expect(page.getByTestId('conflict')).toBeVisible({ timeout: 10_000 });
		expect((await getOwnerPage(owner.request, pageId)).source).toBe('other device');
		await expect(page.getByTestId('conflict')).toContainText('other device');

		await page.getByRole('button', { name: 'この端末の内容で上書き' }).click();
		await expect(saveState(page)).toHaveText('公開済み', { timeout: 10_000 });
		expect((await getOwnerPage(owner.request, pageId)).source).toBe('v1 mine');
	});

	test('an expired session keeps the draft and resends after signing in again', async ({
		browser
	}) => {
		const owner = await ownerContext(browser);
		const { pageId } = await createPage(owner.request, unique('期限切れ'), 'start');
		const page = await owner.newPage();
		await page.goto(`/p/${pageId}/x`);
		await openEditor(page);
		const cookies = await owner.cookies();
		await owner.clearCookies();
		await typeInBody(page, ' after expiry');
		await expect(saveState(page)).toHaveText('ログインが必要です（下書きは端末に保存済み）', {
			timeout: 10_000
		});
		await owner.addCookies(cookies); // simulates signing in again in another tab
		await page.getByRole('button', { name: '再送信' }).click();
		await expect(saveState(page)).toHaveText('公開済み', { timeout: 10_000 });
		expect((await getOwnerPage(owner.request, pageId)).source).toBe('start after expiry');
	});

	test('daily: empty date view, explicit creation by the owner, then edit in place', async ({
		browser
	}) => {
		// A random future date keeps the test repeatable against the same database.
		const date = `2${String(Math.floor(Math.random() * 900) + 100)}-0${1 + Math.floor(Math.random() * 9)}-1${Math.floor(Math.random() * 9)}`;
		const anon = await (await browser.newContext()).newPage();
		await anon.goto(`/daily/${date}`);
		await expect(anon.getByTestId('daily-empty')).toBeVisible();
		await expect(anon.getByTestId('create-daily')).toHaveCount(0);

		const owner = await ownerContext(browser);
		const page = await owner.newPage();
		await page.goto(`/daily/${date}`);
		await page.getByTestId('create-daily').click();
		await expect(page).toHaveURL(/\/p\/[0-9a-f-]{36}\//);
		await expect(page.getByTestId('editor')).toBeVisible();
		await expect(page.getByLabel('タイトル')).toHaveValue(date);
		await typeInBody(page, 'この日の日記');
		await expect(saveState(page)).toHaveText('公開済み', { timeout: 10_000 });

		await anon.goto(`/daily/${date}`);
		await expect(anon).toHaveURL(/\/p\/[0-9a-f-]{36}\//);
		await expect(anon.getByTestId('page-source')).toContainText('この日の日記');
	});

	test('today: resolves the JST date and lands on the daily view or page', async ({ page }) => {
		const tokyo = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
		await page.goto('/today');
		await expect(page).toHaveURL(new RegExp(`/daily/${tokyo}$|/p/[0-9a-f-]{36}/`));
	});

	test('delete shows a deleted state on the same URL and can be restored', async ({ browser }) => {
		const owner = await ownerContext(browser);
		const title = unique('削除');
		const { pageId } = await createPage(owner.request, title, '消す本文');
		const page = await owner.newPage();
		await page.goto(`/p/${pageId}/x`);
		const url = page.url();
		await openEditor(page);
		page.once('dialog', (d) => d.accept());
		await page.getByRole('button', { name: '削除' }).click();
		await expect(page.getByTestId('deleted')).toBeVisible();
		expect(page.url()).toBe(url);

		const anon = await (await browser.newContext()).newPage();
		const res = await anon.goto(`/p/${pageId}/x`);
		expect(res?.status()).toBe(410);
		await expect(anon.getByTestId('page-source')).toHaveCount(0);

		await page.reload();
		await page.getByTestId('restore').click();
		await expect(page.getByTestId('page-source')).toContainText('消す本文');
	});

	test.describe('phone viewport', () => {
		test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

		test('editor fits the screen with touch-sized controls', async ({ browser }) => {
			const owner = await ownerContext(browser, {
				viewport: { width: 390, height: 844 },
				hasTouch: true,
				isMobile: true
			});
			const { pageId } = await createPage(owner.request, unique('スマホ'), 'スマホで編集');
			const page = await owner.newPage();
			await page.goto(`/p/${pageId}/x`);
			await openEditor(page);
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth
			);
			expect(overflow).toBeLessThanOrEqual(0);
			const box = await page.getByRole('button', { name: '削除' }).boundingBox();
			expect(box!.height).toBeGreaterThanOrEqual(44);
			expect((await page.getByTestId('new-page').boundingBox())!.height).toBeGreaterThanOrEqual(44);
		});
	});

	test('@perf typing into a 10,000-character page and editor JS size', async ({ browser }) => {
		const owner = await ownerContext(browser);
		const longText = Array.from({ length: 210 }, (_, i) => `${i} `.padEnd(49, 'あ')).join('\n');
		const { pageId } = await createPage(owner.request, unique('長文'), longText);
		const page = await owner.newPage();
		const scripts = new Map<string, number>();
		page.on('response', async (r) => {
			if (r.request().resourceType() === 'script') {
				scripts.set(new URL(r.url()).pathname, gzipSync(await r.body()).length);
			}
		});
		await page.goto(`/p/${pageId}/x`);
		await openEditor(page);
		await page.waitForLoadState('networkidle');

		await page.locator('.cm-content').click();
		await page.evaluate(() => {
			const w = window as unknown as { __lat: number[] };
			w.__lat = [];
			// beforeinput fires for every inserted character, including IME-less CJK text insertion.
			document.addEventListener(
				'beforeinput',
				() => {
					const t = performance.now();
					requestAnimationFrame(() => w.__lat.push(performance.now() - t));
				},
				true
			);
		});
		await page.keyboard.type('入力遅延の計測 typing latency '.repeat(6), { delay: 20 });
		const lat = (await page.evaluate(() => (window as unknown as { __lat: number[] }).__lat)).sort(
			(a, b) => a - b
		);
		const p95 = lat[Math.floor(lat.length * 0.95)];
		const editorJs = [...scripts.values()].reduce((a, b) => a + b, 0);

		mkdirSync('test-results', { recursive: true });
		writeFileSync(
			'test-results/editor-perf.json',
			JSON.stringify(
				{
					chars: longText.length,
					keystrokes: lat.length,
					p50: lat[Math.floor(lat.length / 2)],
					p95,
					editorJsGzipBytes: editorJs,
					files: Object.fromEntries(scripts)
				},
				null,
				2
			)
		);
		console.log(
			`input→frame p95 ${p95.toFixed(1)}ms (n=${lat.length}); editor page JS ${(editorJs / 1024).toFixed(1)} KiB gzip`
		);
		expect(longText.length).toBeGreaterThanOrEqual(10_000);
		expect(p95).toBeLessThan(50); // design §12.2 (lab, no CPU throttle)
		expect(editorJs).toBeLessThanOrEqual(250 * 1024); // design §12.2 editor first-load budget
	});
});

test('the 今日 link is public and does not create anything', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('link', { name: '今日' })).toBeVisible();
	const res = await page.request.get('/today', { maxRedirects: 0 });
	expect(res.status()).toBe(302);
	expect(res.headers()['cache-control']).toBe('no-store');
	expect(res.headers().location).toMatch(new RegExp(`^/daily/\\d{4}-\\d{2}-\\d{2}$`));
	expect(BASE).toBeTruthy();
});
