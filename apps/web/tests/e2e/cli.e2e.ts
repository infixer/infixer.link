/**
 * Phase 7: a token issued in the browser, then only the `infixer` CLI (ADR 0016).
 * Completion criteria: append to the diary from the CLI alone; export all text.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { BASE, ownerContext } from './helpers';

test.skip(({ browserName }) => browserName !== 'chromium', 'CDP WebAuthn is Chromium-only');

const run = promisify(execFile);
const CLI = path.resolve('../cli/src/main.ts');

async function infixer(
	args: string[],
	env: Record<string, string>,
	input?: string
): Promise<{ code: number; stdout: string; stderr: string }> {
	const child = run('node', ['--disable-warning=ExperimentalWarning', CLI, ...args], {
		env: { ...process.env, ...env },
		encoding: 'utf8'
	});
	if (input !== undefined) {
		child.child.stdin!.end(input);
	} else {
		child.child.stdin!.end();
	}
	try {
		const { stdout, stderr } = await child;
		return { code: 0, stdout, stderr };
	} catch (error) {
		const e = error as { code: number; stdout: string; stderr: string };
		return { code: e.code, stdout: e.stdout, stderr: e.stderr };
	}
}

test('issue a token after a passkey check, then write and export with the CLI only', async ({
	browser
}) => {
	// The shared owner session confirmed its passkey at setup (within the 5-minute window).
	// A second passkey login here would reuse the virtual credential's signature counter,
	// which the server rightly rejects as a possible clone in a concurrent login test.
	const context = await ownerContext(browser);
	const page = await context.newPage();
	await page.goto('/owner/settings');

	await page.getByLabel('トークンの名前').fill('E2E の CLI');
	await page.getByLabel(/持ち出す/).check();
	await page.getByTestId('issue-token').click();
	const token = await page.getByLabel('発行したトークン').inputValue();
	expect(token).toMatch(/^ifx_/);
	await expect(page.getByTestId('tokens')).toContainText('E2E の CLI');

	const config = await mkdtemp(path.join(os.tmpdir(), 'infixer-config-'));
	const env = { INFIXER_URL: BASE, INFIXER_TOKEN: token, XDG_CONFIG_HOME: config };
	const marker = `CLI から追記 ${crypto.randomUUID().slice(0, 8)}`;

	const appended = await infixer(['append', 'today', marker], env);
	expect(appended, appended.stderr).toMatchObject({ code: 0 });
	const today = await infixer(['today', '--json'], env);
	expect(today.code).toBe(0);
	const todayPage = JSON.parse(today.stdout) as { id: string; source: string; dailyDate: string };
	expect(todayPage.source).toContain(marker);

	// Text from stdin, JSON output, and the search index.
	const created = await infixer(
		['create', `CLI ${marker}`, '--file', '-', '--json'],
		env,
		'標準入力から\n二行目\n'
	);
	expect(created.code).toBe(0);
	const createdId = JSON.parse(created.stdout).pageId as string;
	expect((await infixer(['get', createdId], env)).stdout).toBe('標準入力から\n二行目\n');
	const found = await infixer(['search', marker, '--json'], env);
	expect(JSON.parse(found.stdout).hits.map((h: { id: string }) => h.id)).toContain(todayPage.id);

	// A stale base revision is a conflict (exit 4), never a silent overwrite.
	const first = await infixer(['put', createdId, '--file', '-', '--base-revision', '1'], env, 'x');
	expect(first.code).toBe(0);
	const again = await infixer(['put', createdId, '--file', '-', '--base-revision', '1'], env, 'y');
	expect(again.code).toBe(4);
	expect((await infixer(['get', createdId], env)).stdout).toBe('x');

	// Everything as text, plus images, with a verified manifest.
	const out = path.join(await mkdtemp(path.join(os.tmpdir(), 'infixer-export-')), 'export');
	const exported = await infixer(['export', out, '--with-assets', '--json'], env);
	expect(exported, exported.stderr).toMatchObject({ code: 0 });
	const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
	expect(manifest).toMatchObject({ format: 'infixer-link-export', schemaVersion: 1 });
	expect(await readFile(path.join(out, 'pages', `${todayPage.id}.link.txt`), 'utf8')).toContain(
		marker
	);
	expect((await readdir(path.join(out, 'pages'))).length).toBe(manifest.pages);
	expect(manifest.pages).toBeGreaterThan(1);
	expect(manifest.assets.downloaded).toBe(manifest.assets.listed);

	// Exporting into the same directory again is refused (no silent mixing).
	expect((await infixer(['export', out], env)).code).toBe(2);

	// Revoking the token in the browser stops the CLI (exit 5).
	page.once('dialog', (dialog) => void dialog.accept());
	await page
		.getByTestId('tokens')
		.locator('li', { hasText: 'E2E の CLI' })
		.getByRole('button', { name: '失効' })
		.click();
	await expect(page.getByTestId('tokens')).toContainText('失効済み');
	const denied = await infixer(['get', 'today'], env);
	expect(denied.code).toBe(5);
	expect(denied.stderr).not.toContain(token);
	await context.close();
});
