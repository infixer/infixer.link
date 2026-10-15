import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Integration tests that run inside workerd with local D1 / R2 bindings.
// The real migrations are applied before every test file (tests/workers/setup.ts).
export default defineConfig(async () => {
	const migrations = await readD1Migrations('./migrations');
	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: { bindings: { TEST_MIGRATIONS: migrations } }
			})
		],
		test: {
			name: 'workers',
			include: ['tests/workers/**/*.test.ts'],
			setupFiles: ['./tests/workers/setup.ts']
		}
	};
});
