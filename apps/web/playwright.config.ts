import { defineConfig, devices } from '@playwright/test';

// E2E runs against the production build served by `wrangler dev` (workerd + local D1/R2).
// A small smoke suite also runs against `vite dev`, which uses a different CSP and
// injects styles differently (a regression there once blocked every style).
const DEV_PORT = 5174;

export default defineConfig({
	testDir: 'tests/e2e',
	testMatch: '**/*.e2e.ts',
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? 'github' : 'list',
	use: { baseURL: 'http://localhost:4173' },
	webServer: [
		{
			command: 'pnpm build && pnpm e2e:server',
			port: 4173,
			reuseExistingServer: !process.env.CI,
			timeout: 180_000
		},
		{
			command: `pnpm db:migrate && pnpm exec vite dev --port ${DEV_PORT} --strictPort`,
			port: DEV_PORT,
			reuseExistingServer: !process.env.CI,
			timeout: 180_000
		}
	],
	projects: [
		// Registers the owner once (virtual authenticator) and saves the session for other projects.
		{ name: 'owner-setup', testMatch: /owner\.setup\.ts/, use: { ...devices['Desktop Chrome'] } },
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
			dependencies: ['owner-setup'],
			testIgnore: /dev-smoke/
		},
		{
			name: 'webkit',
			use: { ...devices['Desktop Safari'] },
			dependencies: ['owner-setup'],
			testIgnore: /dev-smoke/
		},
		{
			name: 'mobile-webkit',
			use: { ...devices['iPhone 15'] },
			dependencies: ['owner-setup'],
			testIgnore: /dev-smoke/
		},
		{
			name: 'dev-smoke',
			testMatch: /dev-smoke\.e2e\.ts/,
			use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${DEV_PORT}` }
		}
	]
});
