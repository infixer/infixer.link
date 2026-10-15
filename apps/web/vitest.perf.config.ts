import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Opt-in measurements on synthetic 2,000 / 10,000-page databases (design §17 Phase 5).
// Same workerd + local D1 as the integration tests; results go to docs/performance.md.
export default defineConfig(async () => {
	const migrations = await readD1Migrations('./migrations');
	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: './wrangler.jsonc' },
				main: './tests/workers/entry.ts',
				miniflare: { bindings: { TEST_MIGRATIONS: migrations } }
			})
		],
		test: {
			name: 'perf',
			// The measurements are printed as Markdown tables.
			reporters: ['verbose'],
			silent: false,
			include: ['tests/perf/**/*.perf.ts'],
			setupFiles: ['./tests/workers/setup.ts'],
			testTimeout: 600_000,
			hookTimeout: 900_000
		}
	};
});
