import { describe, expect, it } from 'vitest';
import { makeAuthConfig } from '../../src/lib/server/config';

describe('makeAuthConfig', () => {
	it('uses __Host- Secure cookies for HTTPS production origins', () => {
		const config = makeAuthConfig({ RP_ID: 'infixer.link', APP_ORIGINS: 'https://infixer.link' });
		expect(config).toMatchObject({
			rpId: 'infixer.link',
			origins: ['https://infixer.link'],
			secureCookies: true,
			sessionCookie: '__Host-link_session'
		});
	});

	it('rejects origins outside the RP ID, non-HTTPS remote origins and paths', () => {
		expect(() =>
			makeAuthConfig({ RP_ID: 'infixer.link', APP_ORIGINS: 'https://evil.example' })
		).toThrow();
		expect(() =>
			makeAuthConfig({ RP_ID: 'infixer.link', APP_ORIGINS: 'http://infixer.link' })
		).toThrow();
		expect(() =>
			makeAuthConfig({ RP_ID: 'infixer.link', APP_ORIGINS: 'https://infixer.link/x' })
		).toThrow();
		expect(() => makeAuthConfig({ RP_ID: '', APP_ORIGINS: '' })).toThrow();
	});

	it('keeps staging on its own RP ID', () => {
		const config = makeAuthConfig({
			RP_ID: 'staging.infixer.link',
			APP_ORIGINS: 'https://staging.infixer.link'
		});
		expect(config.rpId).toBe('staging.infixer.link');
		expect(() =>
			makeAuthConfig({ RP_ID: 'staging.infixer.link', APP_ORIGINS: 'https://infixer.link' })
		).toThrow();
	});
});
