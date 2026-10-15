/**
 * Import boundaries (design §9, §16): app code never imports test helpers (so no
 * test-only authentication path can ship), and browser code never imports server modules.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return files(path);
		return /\.(ts|svelte)$/.test(name) && !/\.(test|d)\.ts$/.test(name) ? [path] : [];
	});
}

const imports = (path: string) =>
	[...readFileSync(path, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
		(m) => m[1]
	);

describe('import boundaries', () => {
	it('no application module imports test helpers', () => {
		const offenders = files(SRC).filter((f) => imports(f).some((i) => i.includes('tests/')));
		expect(offenders).toEqual([]);
	});

	it('browser modules do not import server-only code', () => {
		const browser = files(SRC).filter(
			(f) => !f.includes('/lib/server/') && !/\.server\.ts$/.test(f) && !/\+server\.ts$/.test(f)
		);
		const offenders = browser.filter((f) =>
			imports(f).some(
				(i) =>
					i.includes('/server/') ||
					i === 'cloudflare:workers' ||
					i.startsWith('@simplewebauthn/server')
			)
		);
		expect(offenders).toEqual([]);
	});
});
