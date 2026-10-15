/** Shared E2E helpers. The owner is registered once by `owner.setup.ts`. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import {
	expect,
	type APIRequestContext,
	type Browser,
	type BrowserContext,
	type Page
} from '@playwright/test';

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

/** A valid solid-color RGB PNG of the given size. */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
		const out = Buffer.alloc(body.length + 8);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(crc32(body), body.length + 4);
		return out;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8; // bit depth
	header[9] = 2; // RGB
	const row = Buffer.alloc(1 + width * 3);
	for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
	const raw = Buffer.concat(Array.from({ length: height }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0))
	]);
}

export async function uploadImage(request: APIRequestContext, png: Buffer): Promise<string> {
	const id = crypto.randomUUID();
	const headers = { origin: BASE, 'x-csrf-token': await csrfToken(request) };
	const put = await request.put(`/api/owner/v1/assets/${id}`, {
		data: png,
		headers: { ...headers, 'content-type': 'image/png' }
	});
	expect(put.status()).toBe(200);
	const done = await request.post(`/api/owner/v1/assets/${id}/complete`, { headers });
	expect(done.status()).toBe(200);
	return id;
}
