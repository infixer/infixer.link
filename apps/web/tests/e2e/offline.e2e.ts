/**
 * Phase 6: Service Worker, offline editing, outbox, three-way conflicts (ADR 0015).
 * Chromium only: Service Worker + offline emulation.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
	BASE,
	createPage,
	csrfToken,
	getOwnerPage,
	ownerContext,
	unique,
	updatePage
} from './helpers';

test.skip(({ browserName }) => browserName !== 'chromium', 'Service Worker flows run on Chromium');

const saveState = (page: Page) => page.getByTestId('save-state');

const tokyoToday = () =>
	new Intl.DateTimeFormat('en-CA', {
		timeZone: 'Asia/Tokyo',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).format(new Date());

async function editorReady(page: Page) {
	await expect(page.getByTestId('editor')).toBeVisible();
	await expect(page.locator('.cm-content')).toBeVisible();
}

/** Opens a page so that the Service Worker controls it and keeps a copy. */
async function openCached(page: Page, path: string) {
	await page.goto(path);
	await editorReady(page);
	await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, {
		timeout: 15_000
	});
	await page.reload();
	await editorReady(page);
}

async function typeAtEnd(page: Page, text: string) {
	await page.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type(text);
}

async function goOffline(context: BrowserContext, page: Page) {
	await context.setOffline(true);
	await page.evaluate(() => window.dispatchEvent(new Event('offline')));
}

test('a visited page opens and is editable offline; the edit is published when back online', async ({
	browser
}) => {
	const owner = await ownerContext(browser);
	const { pageId } = await createPage(owner.request, unique('オフライン'), '一行目');
	const page = await owner.newPage();
	await openCached(page, `/p/${pageId}/x`);

	await goOffline(owner, page);
	await page.reload();
	await expect(page.getByTestId('offline-banner')).toBeVisible();
	await editorReady(page);
	await typeAtEnd(page, '\nオフラインで追記');
	await expect(saveState(page)).toHaveText('オフライン（端末に保存済み）', { timeout: 10_000 });

	await owner.setOffline(false);
	await page.evaluate(() => window.dispatchEvent(new Event('online')));
	await expect(saveState(page)).toHaveText('公開済み', { timeout: 15_000 });
	expect((await getOwnerPage(owner.request, pageId)).source).toBe('一行目\nオフラインで追記');
	await owner.close();
});

test('a page never opened on this device says so while offline', async ({ browser }) => {
	const owner = await ownerContext(browser);
	const page = await owner.newPage();
	await openCached(page, `/p/${(await createPage(owner.request, unique('準備'))).pageId}/x`);
	await goOffline(owner, page);
	await page.goto(`/p/${crypto.randomUUID()}/x`);
	await expect(page.getByTestId('not-cached')).toBeVisible();
	await expect(page.getByTestId('write-today-offline')).toBeVisible();
	await owner.close();
});

test('changes on different lines are merged in one click after a conflict', async ({ browser }) => {
	const owner = await ownerContext(browser);
	const title = unique('三者比較');
	const { pageId } = await createPage(owner.request, title, '一行目\n二行目\n三行目');
	const page = await owner.newPage();
	await openCached(page, `/p/${pageId}/x`);

	await goOffline(owner, page);
	await page.locator('.cm-line').first().click();
	await page.keyboard.press('End');
	await page.keyboard.type('（この端末）');
	await expect(saveState(page)).toHaveText('オフライン（端末に保存済み）', { timeout: 10_000 });

	// Meanwhile another device edits the last line.
	const other = await ownerContext(browser);
	expect(
		(
			await updatePage(other.request, pageId, 1, title, '一行目\n二行目\n三行目（別の端末）')
		).status()
	).toBe(200);

	await owner.setOffline(false);
	await page.evaluate(() => window.dispatchEvent(new Event('online')));
	const conflict = page.getByTestId('conflict');
	await expect(conflict).toBeVisible({ timeout: 15_000 });
	await expect(conflict).toContainText('重なる変更はありません');
	await page.getByTestId('conflict-save').click();
	await expect(saveState(page)).toHaveText('公開済み', { timeout: 10_000 });
	expect((await getOwnerPage(other.request, pageId)).source).toBe(
		'一行目（この端末）\n二行目\n三行目（別の端末）'
	);
	await other.close();
	await owner.close();
});

test('overlapping changes are chosen per block and nothing is overwritten silently', async ({
	browser
}) => {
	const owner = await ownerContext(browser);
	const title = unique('重なり');
	const { pageId } = await createPage(owner.request, title, 'A\nB\nC');
	const page = await owner.newPage();
	await openCached(page, `/p/${pageId}/x`);
	await goOffline(owner, page);
	await page.locator('.cm-line').nth(1).click();
	await page.keyboard.press('End');
	await page.keyboard.type('（端末）');
	await expect(saveState(page)).toHaveText('オフライン（端末に保存済み）', { timeout: 10_000 });

	const other = await ownerContext(browser);
	await updatePage(other.request, pageId, 1, title, 'A\nB（サーバー）\nC');
	await owner.setOffline(false);
	await page.evaluate(() => window.dispatchEvent(new Event('online')));
	await expect(page.getByTestId('conflict-block')).toHaveCount(1, { timeout: 15_000 });
	// Still the server's text until the owner decides.
	expect((await getOwnerPage(other.request, pageId)).source).toBe('A\nB（サーバー）\nC');

	await page.getByTestId('conflict-block').getByLabel('両方を残す').check();
	await page.getByTestId('conflict-save').click();
	await expect(saveState(page)).toHaveText('公開済み', { timeout: 10_000 });
	expect((await getOwnerPage(other.request, pageId)).source).toBe('A\nB（端末）\nB（サーバー）\nC');
	await other.close();
	await owner.close();
});

test('a page created offline with 新規 is published when the network returns', async ({
	browser
}) => {
	const owner = await ownerContext(browser);
	const page = await owner.newPage();
	await openCached(page, `/p/${(await createPage(owner.request, unique('準備'))).pageId}/x`);
	await goOffline(owner, page);
	await page.getByTestId('new-page').click();
	await expect(page).toHaveURL(/\/offline\?draft=/);
	await editorReady(page);
	await expect(page.getByTestId('local-only')).toBeVisible();
	const pageId = new URL(page.url()).searchParams.get('draft')!;
	await page.keyboard.type('電車の中で書いた');

	await owner.setOffline(false);
	await page.evaluate(() => window.dispatchEvent(new Event('online')));
	await expect(page).toHaveURL(new RegExp(`/p/${pageId}`), { timeout: 15_000 });
	expect((await getOwnerPage(owner.request, pageId)).source).toBe('電車の中で書いた');
	await owner.close();
});

test("today's diary written offline is added to the one another device created first", async ({
	browser
}) => {
	const owner = await ownerContext(browser);
	const date = tokyoToday();
	const existing = await owner.request.post(`/api/owner/v1/daily/${date}`, {
		data: { mutationId: crypto.randomUUID() },
		headers: { origin: BASE, 'x-csrf-token': await csrfToken(owner.request) }
	});
	const { pageId: existingId } = await existing.json();
	const before = (await getOwnerPage(owner.request, existingId)).source as string;

	const page = await owner.newPage();
	await openCached(page, `/p/${(await createPage(owner.request, unique('準備'))).pageId}/x`);
	await goOffline(owner, page);
	await page.goto('/today');
	await page.getByTestId('write-today-offline').click();
	await editorReady(page);
	const marker = `オフラインの日記 ${crypto.randomUUID().slice(0, 8)}`;
	await page.keyboard.type(marker);
	await expect(saveState(page)).toHaveText('オフライン（端末に保存済み）', { timeout: 10_000 });

	await owner.setOffline(false);
	await page.evaluate(() => window.dispatchEvent(new Event('online')));
	await expect(page.getByTestId('daily-collision')).toBeVisible({ timeout: 15_000 });
	await page.getByTestId('append-to-existing').click();
	await expect(page).toHaveURL(new RegExp(`/p/${existingId}/`));
	// Other tests may edit today's page at the same time: then the owner is asked, and
	// keeping both sides must still publish this device's text.
	for (let attempt = 0; attempt < 5; attempt++) {
		await expect(saveState(page)).toHaveText(/公開済み|別の版と競合しています/, {
			timeout: 15_000
		});
		if (!(await saveState(page).textContent())?.includes('競合')) break;
		await expect(page.getByTestId('conflict')).toBeVisible();
		for (const block of await page.getByTestId('conflict-block').all()) {
			await block.getByLabel('両方を残す').check();
		}
		await page.getByTestId('conflict-save').click();
	}
	await expect(saveState(page)).toHaveText('公開済み');
	const after = (await getOwnerPage(owner.request, existingId)).source as string;
	expect(after).toContain(before.trimEnd());
	expect(after).toContain(marker);
	await owner.close();
});

test('unsent drafts of pages that are not open are sent in the background', async ({ browser }) => {
	const owner = await ownerContext(browser);
	const title = unique('裏で送信');
	const { pageId } = await createPage(owner.request, title, '元の本文');
	const page = await owner.newPage();
	await page.goto('/search');
	// A draft left by an earlier visit (e.g. the tab was closed while offline).
	await page.evaluate(
		async ({ pageId, title }) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const req = indexedDB.open('infixer-link', 2);
				req.onupgradeneeded = () => {
					req.result.createObjectStore('drafts', { keyPath: 'pageId' });
					req.result
						.createObjectStore('uploads', { keyPath: 'assetId' })
						.createIndex('pageId', 'pageId');
				};
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			});
			await new Promise((resolve, reject) => {
				const tx = db.transaction('drafts', 'readwrite');
				tx.objectStore('drafts').put({
					pageId,
					title,
					source: '元の本文\n閉じる前に書いた',
					baseRevision: 1,
					base: { title, source: '元の本文' },
					savedAt: Date.now()
				});
				tx.oncomplete = resolve;
				tx.onerror = () => reject(tx.error);
			});
			db.close();
		},
		{ pageId, title }
	);
	await page.goto('/');
	await expect
		.poll(async () => (await getOwnerPage(owner.request, pageId)).source, { timeout: 15_000 })
		.toBe('元の本文\n閉じる前に書いた');
	await page.goto('/offline');
	await expect(page.getByTestId('no-drafts')).toBeVisible();
	await owner.close();
});

test('the Service Worker never stores owner API responses or owner pages', async ({ browser }) => {
	const owner = await ownerContext(browser);
	const page = await owner.newPage();
	await openCached(page, `/p/${(await createPage(owner.request, unique('キャッシュ'))).pageId}/x`);
	await page.goto('/owner/settings');
	await page.goto('/');
	const keys = await page.evaluate(async () => {
		const urls: string[] = [];
		for (const name of await caches.keys()) {
			for (const req of await (await caches.open(name)).keys())
				urls.push(new URL(req.url).pathname);
		}
		return urls;
	});
	expect(keys.some((k) => k.startsWith('/p/'))).toBe(true);
	expect(keys.filter((k) => k.startsWith('/api/') || k.startsWith('/owner'))).toEqual([]);
	await owner.close();
});

test('logging out with unsent changes asks what to do with them', async ({ browser }) => {
	const owner = await ownerContext(browser);
	const page = await owner.newPage();
	await page.goto('/owner/settings');
	await page.evaluate(async () => {
		const db = await new Promise<IDBDatabase>((resolve) => {
			const req = indexedDB.open('infixer-link', 2);
			req.onupgradeneeded = () => {
				req.result.createObjectStore('drafts', { keyPath: 'pageId' });
				req.result
					.createObjectStore('uploads', { keyPath: 'assetId' })
					.createIndex('pageId', 'pageId');
			};
			req.onsuccess = () => resolve(req.result);
		});
		const tx = db.transaction('drafts', 'readwrite');
		tx.objectStore('drafts').put({
			pageId: crypto.randomUUID(),
			title: '未送信',
			source: 'x',
			baseRevision: 1,
			conflict: true, // waits for the owner, so the background sync leaves it alone
			savedAt: Date.now()
		});
		await new Promise((r) => (tx.oncomplete = r));
		db.close();
	});
	await page.getByRole('button', { name: 'この端末からログアウト' }).click();
	await expect(page.getByTestId('logout-choice')).toContainText('ページ 1 件');
	// Do not actually log out: the owner session is shared by the other tests.
	await page.getByRole('button', { name: 'キャンセル' }).click();
	await expect(page.getByTestId('logout-choice')).toHaveCount(0);
	await owner.close();
});
