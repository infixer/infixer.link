/** Shared E2E helpers. The owner is registered once by `owner.setup.ts`. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';

export const BASE = 'http://localhost:4173';
export const AUTH_DIR = 'test-results/.auth';
export const OWNER_STATE = `${AUTH_DIR}/owner.json`;
export const CREDENTIAL_FILE = `${AUTH_DIR}/credential.json`;

export function mintCode(purpose: 'setup' | 'recovery' = 'setup'): string {
	const out = execFileSync(
		'node',
		['scripts/owner-grant.ts', '--purpose', purpose, '--persist-to', '.wrangler/e2e', '--json'],
		{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
	);
	return JSON.parse(out.trim().split('\n').at(-1)!).token;
}

/** Chromium-only: attaches a virtual platform authenticator, optionally with a saved credential. */
export async function addVirtualAuthenticator(page: Page, withSavedCredential = false) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true
		}
	});
	if (withSavedCredential) {
		const credential = JSON.parse(readFileSync(CREDENTIAL_FILE, 'utf8'));
		await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
	}
	return { cdp, authenticatorId };
}

/** A browser context signed in as the owner (shared session; never log it out). */
export function ownerContext(browser: Browser, options: Parameters<Browser['newContext']>[0] = {}) {
	return browser.newContext({ ...options, storageState: OWNER_STATE });
}

export async function csrfToken(request: APIRequestContext): Promise<string> {
	const session = await (await request.get('/api/auth/v1/session')).json();
	if (!session.authenticated) throw new Error('owner session is not valid');
	return session.csrfToken;
}

export async function createPage(
	request: APIRequestContext,
	title: string,
	source = ''
): Promise<{ pageId: string; revision: number }> {
	const res = await request.post('/api/owner/v1/pages', {
		data: { mutationId: crypto.randomUUID(), title, format: 'link-text-v1', source },
		headers: { origin: BASE, 'x-csrf-token': await csrfToken(request) }
	});
	if (res.status() !== 201) throw new Error(`create failed: ${res.status()} ${await res.text()}`);
	return res.json();
}

export async function updatePage(
	request: APIRequestContext,
	pageId: string,
	baseRevision: number,
	title: string,
	source: string
) {
	return request.put(`/api/owner/v1/pages/${pageId}`, {
		data: { baseRevision, mutationId: crypto.randomUUID(), title, format: 'link-text-v1', source },
		headers: { origin: BASE, 'x-csrf-token': await csrfToken(request) }
	});
}

export async function getOwnerPage(request: APIRequestContext, pageId: string) {
	return (await request.get(`/api/owner/v1/pages/${pageId}`)).json();
}

export const unique = (prefix: string) => `${prefix} ${crypto.randomUUID().slice(0, 8)}`;

export async function anonymousPage(
	browser: Browser
): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext();
	return { context, page: await context.newPage() };
}
