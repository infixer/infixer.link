import { describe, expect, it } from 'vitest';
import { adjustCsp } from './csp';

const prod =
	"default-src 'self'; img-src 'self' data: blob:; script-src 'self' 'nonce-abc'; style-src 'self' 'unsafe-hashes' 'sha256-x'; frame-ancestors 'none'";
const dev = "default-src 'self'; script-src 'self' 'nonce-abc'; style-src 'self' 'unsafe-inline'";

describe('adjustCsp', () => {
	it('adds the script nonce to style-src in production (CodeMirror styles)', () => {
		expect(adjustCsp(prod, '/media')).toContain(
			"style-src 'self' 'unsafe-hashes' 'sha256-x' 'nonce-abc'"
		);
	});

	it("never adds a nonce next to 'unsafe-inline' (it would block Vite's dev styles)", () => {
		expect(adjustCsp(dev, '/media')).toBe(dev);
	});

	it('allows the media origin for images only when it is absolute', () => {
		expect(adjustCsp(prod, 'https://media.infixer.link/')).toContain(
			"img-src 'self' data: blob: https://media.infixer.link;"
		);
		expect(adjustCsp(prod, '/media')).toContain("img-src 'self' data: blob:;");
	});
});
