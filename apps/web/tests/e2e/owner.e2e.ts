/**
 * Owner flow in a real browser with Chromium's virtual WebAuthn authenticator:
 * setup with an operator-issued code → settings → logout → passkey login,
 * then the public/owner boundary as seen by an anonymous visitor.
 * Runs serially against the fresh e2e D1 (`pnpm e2e:server`).
 */
import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
test.skip(
	({ browserName }) => browserName !== 'chromium',
	'Virtual authenticator is Chromium-only (CDP)'
);

function mintCode(purpose: 'setup' | 'recovery' = 'setup'): string {
	const out = execFileSync(
		'node',
		['scripts/owner-grant.ts', '--purpose', purpose, '--persist-to', '.wrangler/e2e', '--json'],
		{
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		}
	);
	return JSON.parse(out.trim().split('\n').at(-1)!).token;
}

async function addVirtualAuthenticator(page: Page) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	await cdp.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true
		}
	});
}

let ownerPage: Page;

test.beforeAll(async ({ browser }) => {
	ownerPage = await (await browser.newContext()).newPage();
	await addVirtualAuthenticator(ownerPage);
});

test('anonymous visitors see no login entry point or owner UI', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator('a[href*="/owner"]')).toHaveCount(0);
	const res = await page.request.post('/api/owner/v1/pages', {
		data: { mutationId: crypto.randomUUID(), title: 'x', format: 'link-text-v1', source: '' },
		headers: { origin: 'http://localhost:4173' }
	});
	expect(res.status()).toBe(401);
});

test('setup registers the first passkey with an operator code', async () => {
	await ownerPage.goto('/owner/setup');
	await ownerPage.getByLabel('セットアップコード').fill(mintCode());
	await ownerPage.getByLabel('このパスキーの名前（任意）').fill('E2E key');
	await ownerPage.getByRole('button', { name: 'パスキーを登録' }).click();
	await expect(ownerPage).toHaveURL(/\/owner\/settings$/);
	await expect(ownerPage.getByTestId('passkeys')).toContainText('E2E key');
});

test('setup is closed once an owner exists', async ({ page }) => {
	await page.goto('/owner/setup');
	await page.getByLabel('セットアップコード').fill(mintCode());
	await page.getByRole('button', { name: 'パスキーを登録' }).click();
	await expect(page.getByRole('alert')).toBeVisible();
});

test('owner creates a page via the API; it renders publicly without owner data', async ({
	browser
}) => {
	const session = await ownerPage.request.get('/api/auth/v1/session').then((r) => r.json());
	expect(session.authenticated).toBe(true);
	const created = await ownerPage.request.post('/api/owner/v1/pages', {
		data: {
			mutationId: crypto.randomUUID(),
			title: 'E2E の日記',
			format: 'link-text-v1',
			source: '一行目\n [読書] の続き'
		},
		headers: { origin: 'http://localhost:4173', 'x-csrf-token': session.csrfToken }
	});
	expect(created.status()).toBe(201);
	const { pageId } = await created.json();

	const anon = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
	await anon.goto('/');
	await anon.getByRole('link', { name: 'E2E の日記' }).click();
	await expect(anon).toHaveURL(new RegExp(`/p/${pageId}/`));
	await expect(anon.locator('h1')).toHaveText('E2E の日記');
	await expect(anon.getByTestId('page-source')).toContainText('[読書] の続き');
	const html = await anon.content();
	expect(html).not.toContain(session.csrfToken);
	expect(html).not.toContain('/owner');
});

test('logout, then log back in with the passkey and return to the page', async () => {
	await ownerPage.goto('/owner/settings');
	await ownerPage.getByRole('button', { name: 'この端末からログアウト' }).click();
	await expect(ownerPage).toHaveURL('http://localhost:4173/');
	await ownerPage.goto('/owner/settings');
	await expect(ownerPage).toHaveURL(/\/owner\/login\?returnTo=%2Fowner%2Fsettings/);
	await ownerPage.getByRole('button', { name: 'パスキーでログイン' }).click();
	await expect(ownerPage).toHaveURL(/\/owner\/settings$/);
	await expect(ownerPage.getByTestId('sessions')).toContainText('この端末');
});

test('owner pages are not cacheable or indexable', async () => {
	const res = await ownerPage.request.get('/owner/settings');
	expect(res.headers()['cache-control']).toBe('no-store');
	expect(res.headers()['x-robots-tag']).toContain('noindex');
	expect(res.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
});
