import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Integration tests that run inside workerd with local D1 / R2 bindings.
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' }
		})
	],
	test: {
		name: 'workers',
		include: ['tests/workers/**/*.test.ts']
	}
});
