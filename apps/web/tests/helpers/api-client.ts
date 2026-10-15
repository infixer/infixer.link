/**
 * Test client for the Hono API running inside workerd: keeps a cookie jar and
 * the CSRF token like a browser would. Test-only; never import from app code.
 */
import { env } from 'cloudflare:workers';
import { createApi } from '../../src/lib/server/api/app';
import { makeAuthConfig } from '../../src/lib/server/config';
import { mintGrant, type GrantPurpose } from '../../src/lib/server/auth/grants';
import { SoftAuthenticator } from './soft-authenticator';

export const ORIGIN = 'http://localhost:5173';
export const RP_ID = 'localhost';
export const config = makeAuthConfig({ RP_ID, APP_ORIGINS: ORIGIN });

const TABLES = [
	'link_previews',
	'pages_fts',
	'changes',
	'page_assets',
	'page_links',
	'page_revisions',
	'page_names',
	'pages',
	'auth_rate_limits',
	'auth_challenges',
	'sessions',
	'api_tokens',
	'passkeys',
	'setup_grants',
	'owner',
	'tx_guard'
];

export async function resetDb() {
	await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

export class Clock {
	constructor(public ms = Date.UTC(2026, 9, 15, 3, 0, 0)) {}
	advance(ms: number) {
		this.ms += ms;
	}
	now = () => this.ms;
}

export interface CallOptions {
	method?: string;
	body?: unknown;
	headers?: Record<string, string>;
	/** Omit the Origin header (default: same origin for non-GET). */
	origin?: string | null;
	csrf?: boolean;
	ip?: string;
	url?: string;
}

export class ApiClient {
	readonly cookies = new Map<string, string>();
	csrfToken?: string;

	constructor(readonly api = createApi({ db: env.DB, config, now: () => Date.now() })) {}

	async call(path: string, options: CallOptions = {}): Promise<Response> {
		const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
		const headers: Record<string, string> = {
			'cf-connecting-ip': options.ip ?? '203.0.113.1',
			...options.headers
		};
		if (options.body !== undefined) headers['content-type'] ??= 'application/json';
		if (method !== 'GET' && options.origin !== null) headers.origin = options.origin ?? ORIGIN;
		if (options.csrf !== false && this.csrfToken && method !== 'GET') {
			headers['x-csrf-token'] = this.csrfToken;
		}
		if (this.cookies.size) {
			headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
		}
		const res = await this.api.request(options.url ?? `${ORIGIN}${path}`, {
			method,
			headers,
			body:
				options.body === undefined
					? undefined
					: typeof options.body === 'string'
						? options.body
						: JSON.stringify(options.body)
		});
		for (const line of res.headers.getSetCookie()) {
			const [pair, ...attrs] = line.split(';');
			const name = pair.slice(0, pair.indexOf('='));
			const value = pair.slice(pair.indexOf('=') + 1);
			const expired = attrs.some((a) => /max-age=0/i.test(a.trim()));
			if (!value || expired) this.cookies.delete(name);
			else this.cookies.set(name, value);
		}
		return res;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON in tests
	async json<T = any>(
		path: string,
		options: CallOptions = {}
	): Promise<{ status: number; body: T }> {
		const res = await this.call(path, options);
		return { status: res.status, body: (await res.json()) as T };
	}

	async refreshCsrf() {
		const { body } = await this.json('/api/auth/v1/session');
		this.csrfToken = body.authenticated ? body.csrfToken : undefined;
		return body;
	}

	/** Mints a grant (as the operator CLI would) and completes setup with a new soft passkey. */
	async setupOwner(purpose: GrantPurpose = 'setup', authenticator?: SoftAuthenticator) {
		const token = await issueGrant(purpose);
		const key = authenticator ?? (await SoftAuthenticator.create());
		const options = await this.json('/api/auth/v1/setup/options', { body: { token } });
		if (options.status !== 200)
			throw new Error(`setup/options ${options.status} ${JSON.stringify(options.body)}`);
		const response = await key.register({
			challenge: options.body.options.challenge,
			rpId: RP_ID,
			origin: ORIGIN,
			userHandle: options.body.options.user.id
		});
		const verify = await this.json('/api/auth/v1/setup/verify', {
			body: { response, name: 'test key' }
		});
		if (verify.status !== 200)
			throw new Error(`setup/verify ${verify.status} ${JSON.stringify(verify.body)}`);
		await this.refreshCsrf();
		return key;
	}

	async login(
		key: SoftAuthenticator,
		purpose: 'login' | 'reauth' = 'login',
		overrides: { origin?: string } = {}
	) {
		const options = await this.json('/api/auth/v1/authentication/options', { body: { purpose } });
		if (options.status !== 200) return options;
		const response = await key.authenticate({
			challenge: options.body.options.challenge,
			rpId: RP_ID,
			origin: overrides.origin ?? ORIGIN
		});
		const result = await this.json('/api/auth/v1/authentication/verify', { body: { response } });
		if (result.status === 200) await this.refreshCsrf();
		return result;
	}
}

export async function issueGrant(purpose: GrantPurpose, now = Date.now()): Promise<string> {
	const grant = await mintGrant(purpose, now);
	await env.DB.batch(grant.statements.map((s) => env.DB.prepare(s)));
	return grant.token;
}

export function newPage(overrides: Record<string, unknown> = {}) {
	return {
		mutationId: crypto.randomUUID(),
		title: `ページ ${crypto.randomUUID().slice(0, 8)}`,
		format: 'link-text-v1',
		source: '本文',
		...overrides
	};
}
