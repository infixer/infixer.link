/**
 * Owner-only passkey authentication through the HTTP API (design §9, §14.2).
 * Uses the software authenticator; no test-only bypass exists in the app.
 */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '../../src/lib/server/api/app';
import {
	ApiClient,
	Clock,
	ORIGIN,
	RP_ID,
	config,
	issueGrant,
	newPage,
	resetDb
} from '../helpers/api-client';
import { SoftAuthenticator } from '../helpers/soft-authenticator';

beforeEach(resetDb);

describe('bootstrap (setup grant)', () => {
	it('cannot register without a grant and setup page alone grants nothing', async () => {
		const anon = new ApiClient();
		const res = await anon.json('/api/auth/v1/setup/options', { body: { token: 'x'.repeat(43) } });
		expect(res.status).toBe(403);
		expect(res.body.code).toBe('setup_unavailable');
	});

	it('completes setup once; the grant and setup path are closed afterwards', async () => {
		const token = await issueGrant('setup');
		const first = new ApiClient();
		const options = await first.json('/api/auth/v1/setup/options', { body: { token } });
		expect(options.status).toBe(200);
		expect(options.body.options.authenticatorSelection).toMatchObject({
			residentKey: 'required',
			userVerification: 'required'
		});
		const key = await SoftAuthenticator.create();
		const response = await key.register({
			challenge: options.body.options.challenge,
			rpId: RP_ID,
			origin: ORIGIN,
			userHandle: options.body.options.user.id
		});
		expect((await first.json('/api/auth/v1/setup/verify', { body: { response } })).status).toBe(
			200
		);
		expect((await first.refreshCsrf()).authenticated).toBe(true);

		// Same grant again: rejected.
		const second = new ApiClient();
		expect((await second.json('/api/auth/v1/setup/options', { body: { token } })).status).toBe(403);
		// A fresh setup grant after completion: rejected (setup is not reopened).
		const again = await issueGrant('setup');
		expect(
			(await second.json('/api/auth/v1/setup/options', { body: { token: again } })).body.code
		).toBe('setup_unavailable');
	});

	it('lets only one of two parallel setups with different grants become owner', async () => {
		const [t1, t2] = [await issueGrant('setup'), await issueGrant('setup')];
		const run = async (token: string) => {
			const client = new ApiClient();
			const options = await client.json('/api/auth/v1/setup/options', { body: { token } });
			const key = await SoftAuthenticator.create();
			const response = await key.register({
				challenge: options.body.options.challenge,
				rpId: RP_ID,
				origin: ORIGIN,
				userHandle: options.body.options.user.id
			});
			return { client, key, response };
		};
		const [a, b] = await Promise.all([run(t1), run(t2)]);
		const results = await Promise.all([
			a.client.json('/api/auth/v1/setup/verify', { body: { response: a.response } }),
			b.client.json('/api/auth/v1/setup/verify', { body: { response: b.response } })
		]);
		expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
		expect(await env.DB.prepare('SELECT count(*) AS n FROM passkeys').first('n')).toBe(1);
	});

	it('rejects an expired grant', async () => {
		const token = await issueGrant('setup', Date.now() - 11 * 60 * 1000);
		expect(
			(await new ApiClient().json('/api/auth/v1/setup/options', { body: { token } })).status
		).toBe(403);
	});

	it('binds the ceremony to the browser that started it', async () => {
		const token = await issueGrant('setup');
		const starter = new ApiClient();
		const options = await starter.json('/api/auth/v1/setup/options', { body: { token } });
		const key = await SoftAuthenticator.create();
		const response = await key.register({
			challenge: options.body.options.challenge,
			rpId: RP_ID,
			origin: ORIGIN,
			userHandle: options.body.options.user.id
		});
		const thief = new ApiClient(); // no ceremony cookie
		expect((await thief.json('/api/auth/v1/setup/verify', { body: { response } })).status).toBe(
			400
		);
	});
});

describe('login', () => {
	let key: SoftAuthenticator;
	beforeEach(async () => {
		key = await new ApiClient().setupOwner();
	});

	it('logs in with the registered passkey and receives an HttpOnly session cookie', async () => {
		const client = new ApiClient();
		const options = await client.call('/api/auth/v1/authentication/options', {
			body: { purpose: 'login' }
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON in tests
		const optionsBody = (await options.json()) as any;
		expect(optionsBody.options.allowCredentials ?? []).toEqual([]); // no credential enumeration
		expect(options.headers.get('cache-control')).toBe('no-store');
		const response = await key.authenticate({
			challenge: optionsBody.options.challenge,
			rpId: RP_ID,
			origin: ORIGIN
		});
		const res = await client.call('/api/auth/v1/authentication/verify', { body: { response } });
		expect(res.status).toBe(200);
		const cookie = res.headers.getSetCookie().find((c) => c.startsWith('link_session='))!;
		expect(cookie).toMatch(/HttpOnly/);
		expect(cookie).toMatch(/SameSite=Lax/);
		expect((await client.refreshCsrf()).authenticated).toBe(true);
	});

	it('rejects an unregistered passkey', async () => {
		const stranger = await SoftAuthenticator.create();
		// Pretend the stranger knows the owner's user handle.
		await stranger.register({ challenge: 'x', rpId: RP_ID, origin: ORIGIN, userHandle: 'AAAA' });
		expect((await new ApiClient().login(stranger)).status).toBe(401);
	});

	it('rejects a wrong origin in clientDataJSON', async () => {
		expect(
			(await new ApiClient().login(key, 'login', { origin: 'https://evil.example' })).status
		).toBe(401);
	});

	it('rejects requests with a foreign Origin header or host', async () => {
		const client = new ApiClient();
		const res = await client.json('/api/auth/v1/authentication/options', {
			body: { purpose: 'login' },
			origin: 'https://evil.example'
		});
		expect(res.status).toBe(403);
		const viaOtherHost = await client.json('/api/auth/v1/authentication/options', {
			body: { purpose: 'login' },
			url: 'https://infixer-link.example.workers.dev/api/auth/v1/authentication/options'
		});
		expect(viaOtherHost.status).toBe(403);
	});

	it('does not accept the same signed response twice (challenge is single-use)', async () => {
		const client = new ApiClient();
		const options = await client.json('/api/auth/v1/authentication/options', {
			body: { purpose: 'login' }
		});
		const response = await key.authenticate({
			challenge: options.body.options.challenge,
			rpId: RP_ID,
			origin: ORIGIN
		});
		const ceremony = client.cookies.get('link_ceremony')!;
		const replayer = new ApiClient();
		replayer.cookies.set('link_ceremony', ceremony);
		const results = await Promise.all([
			client.json('/api/auth/v1/authentication/verify', { body: { response } }),
			replayer.json('/api/auth/v1/authentication/verify', { body: { response } })
		]);
		expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
		expect(await env.DB.prepare('SELECT count(*) AS n FROM sessions').first('n')).toBe(2); // setup + one login
	});

	it('rejects an expired challenge', async () => {
		const clock = new Clock(Date.now());
		const client = new ApiClient(createApi({ db: env.DB, config, now: clock.now }));
		const options = await client.json('/api/auth/v1/authentication/options', {
			body: { purpose: 'login' }
		});
		clock.advance(6 * 60 * 1000);
		const response = await key.authenticate({
			challenge: options.body.options.challenge,
			rpId: RP_ID,
			origin: ORIGIN
		});
		expect(
			(await client.json('/api/auth/v1/authentication/verify', { body: { response } })).status
		).toBe(400);
	});

	it('rate-limits authentication attempts per IP without locking out other IPs', async () => {
		const client = new ApiClient();
		let last = 0;
		for (let i = 0; i < 31; i++) {
			last = (
				await client.json('/api/auth/v1/authentication/options', { body: { purpose: 'login' } })
			).status;
		}
		expect(last).toBe(429);
		const other = await client.json('/api/auth/v1/authentication/options', {
			body: { purpose: 'login' },
			ip: '198.51.100.7'
		});
		expect(other.status).toBe(200);
	});
});

describe('owner API boundary', () => {
	it('rejects anonymous, bearer and CSRF-less mutations', async () => {
		const anon = new ApiClient();
		expect((await anon.json('/api/owner/v1/pages', { body: newPage() })).status).toBe(401);
		expect((await anon.json(`/api/owner/v1/pages/${crypto.randomUUID()}`)).status).toBe(401);

		const owner = new ApiClient();
		await owner.setupOwner();
		expect(
			(await owner.json('/api/owner/v1/pages', { body: newPage(), csrf: false })).body.code
		).toBe('csrf_failed');
		expect(
			(
				await owner.json('/api/owner/v1/pages', {
					body: newPage(),
					headers: { authorization: 'Bearer x' }
				})
			).status
		).toBe(400); // cookie and Bearer together are rejected as ambiguous (ADR 0016)
		expect(
			(await owner.json('/api/owner/v1/pages', { body: newPage(), origin: null })).status
		).toBe(403);
		expect(
			(
				await owner.call('/api/owner/v1/pages', {
					body: 'title=x',
					headers: { 'content-type': 'text/plain' }
				})
			).status
		).toBe(415);
		expect((await owner.json('/api/owner/v1/pages', { body: newPage() })).status).toBe(201);
	});

	it('logout revokes the session server-side', async () => {
		const owner = new ApiClient();
		await owner.setupOwner();
		const stolenCookie = owner.cookies.get('link_session')!;
		expect((await owner.json('/api/auth/v1/logout', { body: {} })).status).toBe(200);
		const attacker = new ApiClient();
		attacker.cookies.set('link_session', stolenCookie);
		expect((await attacker.refreshCsrf()).authenticated).toBe(false);
	});

	it('expires sessions after the idle window', async () => {
		const clock = new Clock(Date.now());
		const owner = new ApiClient(createApi({ db: env.DB, config, now: clock.now }));
		await owner.setupOwner();
		clock.advance(8 * 24 * 60 * 60 * 1000);
		expect((await owner.refreshCsrf()).authenticated).toBe(false);
	});
});

describe('passkey management and re-authentication', () => {
	it('requires a recent re-authentication to add a passkey, then allows it', async () => {
		const clock = new Clock(Date.now());
		const owner = new ApiClient(createApi({ db: env.DB, config, now: clock.now }));
		const key = await owner.setupOwner();
		clock.advance(10 * 60 * 1000);
		const denied = await owner.json('/api/auth/v1/registration/options', { body: {} });
		expect(denied.body.code).toBe('reauth_required');

		expect((await owner.login(key, 'reauth')).status).toBe(200);
		const options = await owner.json('/api/auth/v1/registration/options', { body: {} });
		expect(options.status).toBe(200);
		expect(options.body.options.excludeCredentials).toHaveLength(1);
		const second = await SoftAuthenticator.create();
		const response = await second.register({
			challenge: options.body.options.challenge,
			rpId: RP_ID,
			origin: ORIGIN,
			userHandle: options.body.options.user.id
		});
		const res = await owner.json('/api/auth/v1/registration/verify', {
			body: { response, name: 'iPhone' }
		});
		expect(res.status).toBe(201);
		const list = await owner.json('/api/owner/v1/passkeys');
		expect(list.body.passkeys.map((p: { name: string }) => p.name)).toEqual(['test key', 'iPhone']);
		// The new key can log in on its own.
		expect((await new ApiClient().login(second)).status).toBe(200);
	});

	it('refuses to delete the last passkey and revokes sessions of a deleted one', async () => {
		const owner = new ApiClient();
		const first = await owner.setupOwner();
		const firstId = first.credentialIdBase64URL;
		expect(
			(await owner.json(`/api/owner/v1/passkeys/${firstId}`, { method: 'DELETE' })).body.code
		).toBe('last_passkey');

		// Add a second key, log in elsewhere with the first, then delete the first.
		const options = await owner.json('/api/auth/v1/registration/options', { body: {} });
		const second = await SoftAuthenticator.create();
		const response = await second.register({
			challenge: options.body.options.challenge,
			rpId: RP_ID,
			origin: ORIGIN,
			userHandle: options.body.options.user.id
		});
		await owner.json('/api/auth/v1/registration/verify', { body: { response } });
		const laptop = new ApiClient();
		await laptop.login(first);

		const phone = new ApiClient();
		await phone.login(second);
		expect(
			(await phone.json(`/api/owner/v1/passkeys/${firstId}`, { method: 'DELETE' })).status
		).toBe(200);
		expect((await laptop.refreshCsrf()).authenticated).toBe(false);
		expect((await new ApiClient().login(first)).status).toBe(401);
		expect((await phone.refreshCsrf()).authenticated).toBe(true);
	});

	it('re-authentication cannot be completed for a different session', async () => {
		const owner = new ApiClient();
		const key = await owner.setupOwner();
		const options = await owner.json('/api/auth/v1/authentication/options', {
			body: { purpose: 'reauth' }
		});
		const response = await key.authenticate({
			challenge: options.body.options.challenge,
			rpId: RP_ID,
			origin: ORIGIN
		});
		const other = new ApiClient();
		await other.login(key);
		other.cookies.set('link_ceremony', owner.cookies.get('link_ceremony')!);
		expect(
			(await other.json('/api/auth/v1/authentication/verify', { body: { response } })).status
		).toBe(401);
	});

	it('revokes other sessions only after re-authentication', async () => {
		const clock = new Clock(Date.now());
		const api = createApi({ db: env.DB, config, now: clock.now });
		const owner = new ApiClient(api);
		const key = await owner.setupOwner();
		const other = new ApiClient(api);
		await other.login(key);
		clock.advance(10 * 60 * 1000);
		expect((await owner.json('/api/owner/v1/sessions/revoke-others', { body: {} })).body.code).toBe(
			'reauth_required'
		);
		await owner.login(key, 'reauth');
		expect((await owner.json('/api/owner/v1/sessions/revoke-others', { body: {} })).status).toBe(
			200
		);
		expect((await other.refreshCsrf()).authenticated).toBe(false);
		expect((await owner.refreshCsrf()).authenticated).toBe(true);
	});
});

describe('recovery', () => {
	it('replaces all credentials, sessions and CLI tokens but keeps content', async () => {
		const owner = new ApiClient();
		const lost = await owner.setupOwner();
		await owner.json('/api/owner/v1/pages', { body: newPage({ title: '残る' }) });
		await env.DB.prepare(
			`INSERT INTO api_tokens (id, token_hash, owner_id, label, scopes, created_at) VALUES ('t', 'h', 1, 'cli', 'read', 0)`
		).run();

		const recovered = new ApiClient();
		const fresh = await recovered.setupOwner('recovery');
		expect((await owner.refreshCsrf()).authenticated).toBe(false);
		expect((await new ApiClient().login(lost)).status).toBe(401);
		expect((await new ApiClient().login(fresh)).status).toBe(200);
		expect(
			await env.DB.prepare('SELECT count(*) AS n FROM api_tokens WHERE revoked_at IS NULL').first(
				'n'
			)
		).toBe(0);
		expect((await new ApiClient().json('/api/public/v1/pages')).body.pages).toHaveLength(1);
	});
});
