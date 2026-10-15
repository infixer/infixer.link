import { env } from 'cloudflare:workers';

export interface AuthConfig {
	rpId: string;
	rpName: string;
	/** Exact origins allowed for WebAuthn ceremonies and state-changing requests. */
	origins: string[];
	/** `__Host-` + Secure cookies on HTTPS; plain names on http://localhost for local dev. */
	secureCookies: boolean;
	sessionCookie: string;
	ceremonyCookie: string;
}

export const AUTH_TIMING = {
	challengeTtlMs: 5 * 60 * 1000,
	sessionIdleMs: 7 * 24 * 60 * 60 * 1000,
	sessionAbsoluteMs: 30 * 24 * 60 * 60 * 1000,
	reauthWindowMs: 5 * 60 * 1000,
	/** Only refresh last_seen / idle expiry this often to save D1 writes. */
	touchIntervalMs: 60 * 60 * 1000
} as const;

export function makeAuthConfig(vars: { RP_ID: string; APP_ORIGINS: string }): AuthConfig {
	const origins = vars.APP_ORIGINS.split(',')
		.map((o) => o.trim())
		.filter(Boolean);
	if (!vars.RP_ID || origins.length === 0) {
		throw new Error('RP_ID and APP_ORIGINS must be configured');
	}
	for (const origin of origins) {
		const url = new URL(origin);
		if (url.origin !== origin) throw new Error(`APP_ORIGINS entry is not an origin: ${origin}`);
		const host = url.hostname;
		if (host !== vars.RP_ID && !host.endsWith(`.${vars.RP_ID}`)) {
			throw new Error(`origin ${origin} is not within RP ID ${vars.RP_ID}`);
		}
		if (url.protocol !== 'https:' && host !== 'localhost') {
			throw new Error(`non-HTTPS origin is only allowed for localhost: ${origin}`);
		}
	}
	const secureCookies = origins.every((o) => o.startsWith('https://'));
	return {
		rpId: vars.RP_ID,
		rpName: 'infixer.link',
		origins,
		secureCookies,
		sessionCookie: secureCookies ? '__Host-link_session' : 'link_session',
		ceremonyCookie: secureCookies ? '__Host-link_ceremony' : 'link_ceremony'
	};
}

let cached: AuthConfig | undefined;

export function authConfig(): AuthConfig {
	cached ??= makeAuthConfig({ RP_ID: env.RP_ID, APP_ORIGINS: env.APP_ORIGINS });
	return cached;
}
