import { describe, expect, it } from 'vitest';
import { pagePath, safeReturnTo } from './paths';

describe('safeReturnTo', () => {
	it('keeps same-origin paths', () => {
		expect(safeReturnTo('/p/abc/title?x=1#h')).toBe('/p/abc/title?x=1#h');
		expect(safeReturnTo('/owner/settings')).toBe('/owner/settings');
	});

	it('rejects absolute, protocol-relative and backslash URLs', () => {
		for (const value of [
			'https://evil.example/',
			'//evil.example/x',
			'/\\evil.example',
			'javascript:alert(1)',
			'',
			null
		]) {
			expect(safeReturnTo(value)).toBe('/');
		}
	});
});

describe('pagePath', () => {
	it('uses the id as identifier and an encoded slug for display', () => {
		expect(pagePath({ id: 'id1', title: 'アンチ オイディプス' })).toBe(
			`/p/id1/${encodeURIComponent('アンチ_オイディプス')}`
		);
	});
});
