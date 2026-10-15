/**
 * Registers the owner once per E2E run through the real setup screen (Chromium virtual
 * authenticator), then saves the signed-in storage state and the credential so other
 * tests can reuse the session or log in again.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test as setup } from '@playwright/test';
import {
	AUTH_DIR,
	CREDENTIAL_FILE,
	OWNER_STATE,
	addVirtualAuthenticator,
	mintCode
} from './helpers';

setup('register the owner passkey with an operator code', async ({ page }) => {
	const { cdp, authenticatorId } = await addVirtualAuthenticator(page);
	await page.goto('/owner/setup');
	await page.getByLabel('セットアップコード').fill(mintCode());
	await page.getByLabel('このパスキーの名前（任意）').fill('E2E key');
	await page.getByRole('button', { name: 'パスキーを登録' }).click();
	await expect(page).toHaveURL(/\/owner\/settings$/);
	await expect(page.getByTestId('passkeys')).toContainText('E2E key');

	mkdirSync(AUTH_DIR, { recursive: true });
	await page.context().storageState({ path: OWNER_STATE });
	const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
	writeFileSync(CREDENTIAL_FILE, JSON.stringify(credentials[0]));
});
