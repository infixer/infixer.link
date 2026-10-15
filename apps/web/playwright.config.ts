import { defineConfig, devices } from '@playwright/test';

// E2E runs against the production build served by `wrangler dev` (workerd + local D1/R2).
export default defineConfig({
	testDir: 'tests/e2e',
	testMatch: '**/*.e2e.ts',
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? 'github' : 'list',
	use: { baseURL: 'http://localhost:4173' },
	webServer: {
		command: 'pnpm build && pnpm e2e:server',
		port: 4173,
		reuseExistingServer: !process.env.CI,
		timeout: 180_000
	},
	projects: [
		// Registers the owner once (virtual authenticator) and saves the session for other projects.
		{ name: 'owner-setup', testMatch: /owner\.setup\.ts/, use: { ...devices['Desktop Chrome'] } },
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] }, dependencies: ['owner-setup'] },
		{ name: 'webkit', use: { ...devices['Desktop Safari'] }, dependencies: ['owner-setup'] },
		{ name: 'mobile-webkit', use: { ...devices['iPhone 15'] }, dependencies: ['owner-setup'] }
	]
});
