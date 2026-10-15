/**
 * Owner/public boundary and passkey login in a real browser. The owner was registered by
 * `owner.setup.ts`; login tests use the saved credential in a fresh virtual authenticator.
 */
import { expect, test } from '@playwright/test';
import {
	BASE,
	addVirtualAuthenticator,
	createPage,
	mintCode,
	ownerContext,
	unique
} from './helpers';

test('anonymous visitors see no login entry point or owner UI', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator('a[href*="/owner"]')).toHaveCount(0);
	const res = await page.request.post('/api/owner/v1/pages', {
		data: { mutationId: crypto.randomUUID(), title: 'x', format: 'link-text-v1', source: '' },
		headers: { origin: BASE }
	});
	expect(res.status()).toBe(401);
});

test('setup is closed once an owner exists', async ({ page, browserName }) => {
	// Mints a code via `wrangler d1 execute`; run once to avoid concurrent writes to the local DB file.
	test.skip(browserName !== 'chromium', 'browser-independent; runs on Chromium only');
	await page.goto('/owner/setup');
	await page.getByLabel('セットアップコード').fill(mintCode());
	await page.getByRole('button', { name: 'パスキーを登録' }).click();
	await expect(page.getByRole('alert')).toBeVisible();
});

test('owner-created page renders publicly without owner data or editor code', async ({
	browser
}) => {
	const owner = await ownerContext(browser);
	const title = unique('公開ページ');
	const { pageId } = await createPage(owner.request, title, '一行目\n [読書] の続き');

	const anon = await (await browser.newContext()).newPage();
	const scripts: string[] = [];
	anon.on('response', async (r) => {
		if (r.request().resourceType() === 'script') scripts.push(await r.text().catch(() => ''));
	});
	await anon.goto('/');
	await anon.getByRole('link', { name: title }).click();
	await expect(anon).toHaveURL(new RegExp(`/p/${pageId}/`));
	await expect(anon.locator('h1')).toHaveText(title);
	await expect(anon.getByTestId('page-source')).toContainText('[読書] の続き');
	await anon.waitForLoadState('networkidle');
	await expect(anon.getByTestId('editor')).toHaveCount(0);
	expect(scripts.some((s) => s.includes('cm-content'))).toBe(false); // no CodeMirror for visitors
	expect(await anon.content()).not.toContain('/owner');
});

test.describe('passkey login (Chromium virtual authenticator)', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'CDP WebAuthn is Chromium-only');

	test('logs in, returns to the requested page, and logs out', async ({ browser }) => {
		const context = await browser.newContext();
		const page = await context.newPage();
		await addVirtualAuthenticator(page, true);
		await page.goto('/owner/settings');
		await expect(page).toHaveURL(/\/owner\/login\?returnTo=%2Fowner%2Fsettings/);
		await page.getByRole('button', { name: 'パスキーでログイン' }).click();
		await expect(page).toHaveURL(/\/owner\/settings$/);
		await expect(page.getByTestId('sessions')).toContainText('この端末');
		await page.getByRole('button', { name: 'この端末からログアウト' }).click();
		await expect(page).toHaveURL(`${BASE}/`);
		const session = await (await page.request.get('/api/auth/v1/session')).json();
		expect(session.authenticated).toBe(false);
	});
});

test('owner pages are not cacheable or indexable', async ({ browser }) => {
	const owner = await ownerContext(browser);
	const res = await owner.request.get('/owner/settings');
	expect(res.headers()['cache-control']).toBe('no-store');
	expect(res.headers()['x-robots-tag']).toContain('noindex');
	expect(res.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
});
