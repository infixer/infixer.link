/**
 * Single-owner passkey authentication (design §9).
 *
 * - Challenges are single-use, short-lived, bound to the starting browser through
 *   an HttpOnly ceremony cookie, and consumed in the same D1 batch that issues the
 *   session / stores the credential. `tx_guard` aborts the batch when a conditional
 *   statement did not affect exactly one row, so concurrent replays cannot both win.
 * - Sessions are opaque 256-bit tokens; only their SHA-256 is stored.
 */
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type { PasskeyDto, SessionSummaryDto } from '@infixer-link/contracts';
import { AUTH_TIMING, type AuthConfig } from '../config';
import { randomToken, sha256Hex, timingSafeEqual } from '../crypto';
import { ApiError, toIso } from '../http';

export interface AuthDeps {
	db: D1Database;
	config: AuthConfig;
}

export interface SessionRecord {
	id: string;
	credentialId: string;
	csrfToken: string;
	reauthenticatedAt: number;
	absoluteExpiresAt: number;
}

export interface IssuedSession {
	token: string;
	maxAgeSeconds: number;
}

type CeremonyPurpose = 'login' | 'reauth' | 'register' | 'setup' | 'recovery';

interface CeremonyRow {
	id: string;
	challenge: string;
	browser_binding_hash: string;
	purpose: CeremonyPurpose;
	session_id: string | null;
	grant_id: string | null;
	expires_at: number;
}

const GUARD = 'INSERT INTO tx_guard (ok) VALUES (changes() = 1)';
const CLEAR_GUARD = 'DELETE FROM tx_guard';

function isGuardFailure(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes('CHECK constraint failed: ok = 1');
}

// ---------------------------------------------------------------------------
// Rate limiting (fixed window, per key). Keys are per IP so a third party cannot
// lock the owner out globally.

export async function rateLimit(
	db: D1Database,
	key: string,
	limit: number,
	windowMs: number,
	now: number
): Promise<void> {
	const windowStart = now - (now % windowMs);
	const row = await db
		.prepare(
			`INSERT INTO auth_rate_limits (key, window_start, count) VALUES (?, ?, 1)
			 ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
			 RETURNING count`
		)
		.bind(key, windowStart)
		.first<{ count: number }>();
	if (row && row.count > limit) {
		throw new ApiError('rate_limited', 'Too many attempts. Try again later.', {
			retryAfterSeconds: Math.ceil((windowStart + windowMs - now) / 1000)
		});
	}
}

// ---------------------------------------------------------------------------
// Sessions

export async function getSession(
	db: D1Database,
	token: string | undefined,
	now: number
): Promise<SessionRecord | null> {
	if (!token || token.length > 128) return null;
	const row = await db
		.prepare(
			`SELECT s.id, s.credential_id, s.csrf_token, s.reauthenticated_at, s.last_seen_at,
			   s.absolute_expires_at
			 FROM sessions s JOIN passkeys p ON p.credential_id = s.credential_id
			 WHERE s.token_hash = ? AND s.revoked_at IS NULL AND p.revoked_at IS NULL
			   AND s.idle_expires_at > ? AND s.absolute_expires_at > ?`
		)
		.bind(await sha256Hex(token), now, now)
		.first<{
			id: string;
			credential_id: string;
			csrf_token: string;
			reauthenticated_at: number;
			last_seen_at: number;
			absolute_expires_at: number;
		}>();
	if (!row) return null;

	if (now - row.last_seen_at > AUTH_TIMING.touchIntervalMs) {
		await db
			.prepare(
				`UPDATE sessions SET last_seen_at = ?1,
				   idle_expires_at = min(?1 + ?2, absolute_expires_at)
				 WHERE id = ?3 AND revoked_at IS NULL`
			)
			.bind(now, AUTH_TIMING.sessionIdleMs, row.id)
			.run();
	}

	return {
		id: row.id,
		credentialId: row.credential_id,
		csrfToken: row.csrf_token,
		reauthenticatedAt: row.reauthenticated_at,
		absoluteExpiresAt: row.absolute_expires_at
	};
}

async function newSession(
	db: D1Database,
	credentialId: string,
	userAgent: string,
	now: number
): Promise<{ statement: D1PreparedStatement; issued: IssuedSession }> {
	const token = randomToken(32);
	const statement = db
		.prepare(
			`INSERT INTO sessions (id, token_hash, owner_id, credential_id, csrf_token, user_agent,
			   created_at, last_seen_at, idle_expires_at, absolute_expires_at, reauthenticated_at)
			 VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			crypto.randomUUID(),
			await sha256Hex(token),
			credentialId,
			randomToken(32),
			userAgent.slice(0, 200),
			now,
			now,
			now + AUTH_TIMING.sessionIdleMs,
			now + AUTH_TIMING.sessionAbsoluteMs,
			now
		);
	return { statement, issued: { token, maxAgeSeconds: AUTH_TIMING.sessionAbsoluteMs / 1000 } };
}

export async function revokeSession(db: D1Database, sessionId: string, now: number) {
	await db
		.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
		.bind(now, sessionId)
		.run();
}

export function hasRecentReauth(session: SessionRecord, now: number): boolean {
	return now - session.reauthenticatedAt <= AUTH_TIMING.reauthWindowMs;
}

export function requireRecentReauth(session: SessionRecord, now: number) {
	if (!hasRecentReauth(session, now)) {
		throw new ApiError('reauth_required', 'Confirm with your passkey to continue');
	}
}

export function checkCsrf(session: SessionRecord, header: string | undefined) {
	if (!header || !timingSafeEqual(header, session.csrfToken)) {
		throw new ApiError('csrf_failed', 'Missing or invalid CSRF token');
	}
}

// ---------------------------------------------------------------------------
// Ceremonies (challenge + browser binding)

async function startCeremony(
	db: D1Database,
	params: {
		purpose: CeremonyPurpose;
		challenge: string;
		sessionId?: string;
		grantId?: string;
		now: number;
	}
): Promise<string> {
	const id = crypto.randomUUID();
	const secret = randomToken(32);
	await db
		.prepare(
			`INSERT INTO auth_challenges (id, challenge, browser_binding_hash, purpose, owner_id,
			   session_id, grant_id, created_at, expires_at)
			 VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`
		)
		.bind(
			id,
			params.challenge,
			await sha256Hex(secret),
			params.purpose,
			params.sessionId ?? null,
			params.grantId ?? null,
			params.now,
			params.now + AUTH_TIMING.challengeTtlMs
		)
		.run();
	return `${id}.${secret}`;
}

async function loadCeremony(
	db: D1Database,
	cookieValue: string | undefined,
	purposes: CeremonyPurpose[],
	now: number
): Promise<CeremonyRow> {
	const invalid = new ApiError('bad_request', 'Sign-in request expired. Please start again.');
	if (!cookieValue) throw invalid;
	const dot = cookieValue.indexOf('.');
	if (dot < 0) throw invalid;
	const id = cookieValue.slice(0, dot);
	const secret = cookieValue.slice(dot + 1);
	const row = await db
		.prepare(
			`SELECT id, challenge, browser_binding_hash, purpose, session_id, grant_id, expires_at
			 FROM auth_challenges WHERE id = ? AND consumed_at IS NULL`
		)
		.bind(id)
		.first<CeremonyRow>();
	if (
		!row ||
		row.expires_at <= now ||
		!purposes.includes(row.purpose) ||
		!timingSafeEqual(row.browser_binding_hash, await sha256Hex(secret))
	) {
		throw invalid;
	}
	return row;
}

function consumeStatements(db: D1Database, ceremonyId: string, now: number): D1PreparedStatement[] {
	return [
		db
			.prepare(
				'UPDATE auth_challenges SET consumed_at = ?1 WHERE id = ?2 AND consumed_at IS NULL AND expires_at > ?1'
			)
			.bind(now, ceremonyId),
		db.prepare(GUARD)
	];
}

async function runGuarded(db: D1Database, statements: D1PreparedStatement[], message: string) {
	try {
		await db.batch([...statements, db.prepare(CLEAR_GUARD)]);
	} catch (error) {
		if (isGuardFailure(error)) throw new ApiError('bad_request', message);
		throw error;
	}
}

async function ownerHandle(db: D1Database): Promise<string> {
	const row = await db
		.prepare('SELECT user_handle FROM owner WHERE id = 1')
		.first<{ user_handle: string }>();
	if (!row) throw new ApiError('setup_unavailable', 'Owner is not set up');
	return row.user_handle;
}

// ---------------------------------------------------------------------------
// Setup / recovery (design §9.2, §9.5)

export async function setupOptions(deps: AuthDeps, token: string, now: number) {
	const { db, config } = deps;
	const grant = await db
		.prepare(
			`SELECT g.id, g.purpose, o.user_handle, o.setup_completed_at
			 FROM setup_grants g JOIN owner o ON o.id = 1
			 WHERE g.token_hash = ? AND g.consumed_at IS NULL AND g.expires_at > ?`
		)
		.bind(await sha256Hex(token), now)
		.first<{
			id: string;
			purpose: 'setup' | 'recovery';
			user_handle: string;
			setup_completed_at: number | null;
		}>();
	if (!grant || (grant.purpose === 'setup' && grant.setup_completed_at !== null)) {
		throw new ApiError('setup_unavailable', 'This setup code is invalid, used or expired');
	}

	const options = await generateRegistrationOptions({
		rpName: config.rpName,
		rpID: config.rpId,
		userName: 'owner',
		userDisplayName: config.rpName,
		userID: isoBase64URL.toBuffer(grant.user_handle),
		attestationType: 'none',
		authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
		timeout: AUTH_TIMING.challengeTtlMs
	});
	const ceremony = await startCeremony(db, {
		purpose: grant.purpose,
		challenge: options.challenge,
		grantId: grant.id,
		now
	});
	return { options, ceremony, purpose: grant.purpose };
}

async function verifyNewCredential(
	config: AuthConfig,
	response: RegistrationResponseJSON,
	expectedChallenge: string
) {
	let verification;
	try {
		verification = await verifyRegistrationResponse({
			response,
			expectedChallenge,
			expectedOrigin: config.origins,
			expectedRPID: config.rpId,
			requireUserVerification: true
		});
	} catch {
		throw new ApiError('bad_request', 'Passkey registration could not be verified');
	}
	if (!verification.verified) {
		throw new ApiError('bad_request', 'Passkey registration could not be verified');
	}
	return verification.registrationInfo;
}

function insertPasskey(
	db: D1Database,
	info: Awaited<ReturnType<typeof verifyNewCredential>>,
	name: string,
	now: number
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO passkeys (credential_id, owner_id, public_key, counter, transports, device_type,
			   backed_up, name, created_at)
			 VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			info.credential.id,
			info.credential.publicKey,
			info.credential.counter,
			JSON.stringify(info.credential.transports ?? []),
			info.credentialDeviceType,
			info.credentialBackedUp ? 1 : 0,
			name,
			now
		);
}

export async function setupVerify(
	deps: AuthDeps,
	ceremonyCookie: string | undefined,
	response: RegistrationResponseJSON,
	options: { name?: string; userAgent: string; now: number }
): Promise<IssuedSession> {
	const { db, config } = deps;
	const { now } = options;
	const ceremony = await loadCeremony(db, ceremonyCookie, ['setup', 'recovery'], now);
	const info = await verifyNewCredential(config, response, ceremony.challenge);
	const session = await newSession(db, info.credential.id, options.userAgent, now);

	const ownerStatements =
		ceremony.purpose === 'setup'
			? [
					db
						.prepare(
							'UPDATE owner SET setup_completed_at = ? WHERE id = 1 AND setup_completed_at IS NULL'
						)
						.bind(now),
					db.prepare(GUARD)
				]
			: [
					// Recovery replaces every credential, session and CLI token. Public content is untouched.
					db
						.prepare(
							'UPDATE owner SET setup_completed_at = coalesce(setup_completed_at, ?) WHERE id = 1'
						)
						.bind(now),
					db.prepare(GUARD),
					db.prepare('UPDATE passkeys SET revoked_at = ? WHERE revoked_at IS NULL').bind(now),
					db.prepare('UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL').bind(now),
					db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE revoked_at IS NULL').bind(now)
				];

	await runGuarded(
		db,
		[
			...consumeStatements(db, ceremony.id, now),
			db
				.prepare(
					`UPDATE setup_grants SET consumed_at = ?1
					 WHERE id = ?2 AND purpose = ?3 AND consumed_at IS NULL AND expires_at > ?1`
				)
				.bind(now, ceremony.grant_id, ceremony.purpose),
			db.prepare(GUARD),
			...ownerStatements,
			insertPasskey(db, info, options.name ?? 'パスキー', now),
			session.statement
		],
		'This setup code was already used or has expired'
	);
	return session.issued;
}

// ---------------------------------------------------------------------------
// Login / re-authentication (discoverable credentials, no credential enumeration)

export async function authenticationOptions(
	deps: AuthDeps,
	purpose: 'login' | 'reauth',
	session: SessionRecord | null,
	now: number
) {
	if (purpose === 'reauth' && !session) {
		throw new ApiError('unauthenticated', 'Sign in first');
	}
	await ownerHandle(deps.db);
	const options = await generateAuthenticationOptions({
		rpID: deps.config.rpId,
		userVerification: 'required',
		timeout: AUTH_TIMING.challengeTtlMs
	});
	const ceremony = await startCeremony(deps.db, {
		purpose,
		challenge: options.challenge,
		sessionId: purpose === 'reauth' ? session!.id : undefined,
		now
	});
	return { options, ceremony };
}

export async function authenticationVerify(
	deps: AuthDeps,
	ceremonyCookie: string | undefined,
	response: AuthenticationResponseJSON,
	options: { session: SessionRecord | null; userAgent: string; now: number }
): Promise<{ purpose: 'login' | 'reauth'; issued?: IssuedSession }> {
	const { db, config } = deps;
	const { now } = options;
	const ceremony = await loadCeremony(db, ceremonyCookie, ['login', 'reauth'], now);
	const purpose = ceremony.purpose as 'login' | 'reauth';
	const rejected = new ApiError('unauthenticated', 'Passkey sign-in failed');

	if (purpose === 'reauth' && options.session?.id !== ceremony.session_id) throw rejected;

	const passkey = await db
		.prepare(
			`SELECT credential_id, public_key, counter, transports FROM passkeys
			 WHERE credential_id = ? AND revoked_at IS NULL`
		)
		.bind(response.id)
		.first<{
			credential_id: string;
			public_key: ArrayBuffer | number[];
			counter: number;
			transports: string;
		}>();
	if (!passkey) throw rejected;
	// The discoverable credential must belong to the single owner.
	const handle = await ownerHandle(db);
	if (!response.response.userHandle || !timingSafeEqual(response.response.userHandle, handle)) {
		throw rejected;
	}

	let verification;
	try {
		verification = await verifyAuthenticationResponse({
			response,
			expectedChallenge: ceremony.challenge,
			expectedOrigin: config.origins,
			expectedRPID: config.rpId,
			requireUserVerification: true,
			credential: {
				id: passkey.credential_id,
				publicKey: new Uint8Array(passkey.public_key),
				counter: passkey.counter,
				transports: JSON.parse(passkey.transports)
			}
		});
	} catch {
		throw rejected;
	}
	if (!verification.verified) throw rejected;

	const updatePasskey = [
		db
			.prepare(
				'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ? AND revoked_at IS NULL'
			)
			.bind(verification.authenticationInfo.newCounter, now, passkey.credential_id),
		db.prepare(GUARD)
	];

	if (purpose === 'login') {
		const session = await newSession(db, passkey.credential_id, options.userAgent, now);
		await runGuarded(
			db,
			[...consumeStatements(db, ceremony.id, now), ...updatePasskey, session.statement],
			'Sign-in request was already used'
		);
		return { purpose, issued: session.issued };
	}

	await runGuarded(
		db,
		[
			...consumeStatements(db, ceremony.id, now),
			...updatePasskey,
			db
				.prepare(
					`UPDATE sessions SET reauthenticated_at = ?1
					 WHERE id = ?2 AND revoked_at IS NULL AND absolute_expires_at > ?1`
				)
				.bind(now, ceremony.session_id),
			db.prepare(GUARD)
		],
		'Confirmation request was already used'
	);
	return { purpose };
}

// ---------------------------------------------------------------------------
// Additional passkeys (requires recent re-authentication)

export async function registrationOptions(deps: AuthDeps, session: SessionRecord, now: number) {
	requireRecentReauth(session, now);
	const { db, config } = deps;
	const { results } = await db
		.prepare('SELECT credential_id, transports FROM passkeys WHERE revoked_at IS NULL')
		.all<{ credential_id: string; transports: string }>();
	const options = await generateRegistrationOptions({
		rpName: config.rpName,
		rpID: config.rpId,
		userName: 'owner',
		userDisplayName: config.rpName,
		userID: isoBase64URL.toBuffer(await ownerHandle(db)),
		attestationType: 'none',
		authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
		excludeCredentials: results.map((r) => ({
			id: r.credential_id,
			transports: JSON.parse(r.transports)
		})),
		timeout: AUTH_TIMING.challengeTtlMs
	});
	const ceremony = await startCeremony(db, {
		purpose: 'register',
		challenge: options.challenge,
		sessionId: session.id,
		now
	});
	return { options, ceremony };
}

export async function registrationVerify(
	deps: AuthDeps,
	ceremonyCookie: string | undefined,
	response: RegistrationResponseJSON,
	options: { session: SessionRecord; name?: string; now: number }
) {
	const { db, config } = deps;
	const { session, now } = options;
	requireRecentReauth(session, now);
	const ceremony = await loadCeremony(db, ceremonyCookie, ['register'], now);
	if (ceremony.session_id !== session.id) {
		throw new ApiError('bad_request', 'Registration request belongs to another session');
	}
	const info = await verifyNewCredential(config, response, ceremony.challenge);
	try {
		await runGuarded(
			db,
			[
				...consumeStatements(db, ceremony.id, now),
				db
					.prepare(
						`UPDATE sessions SET reauthenticated_at = reauthenticated_at
						 WHERE id = ? AND revoked_at IS NULL AND reauthenticated_at >= ?`
					)
					.bind(session.id, now - AUTH_TIMING.reauthWindowMs),
				db.prepare(GUARD),
				insertPasskey(db, info, options.name ?? 'パスキー', now)
			],
			'Registration request was already used'
		);
	} catch (error) {
		if (error instanceof Error && error.message.includes('passkeys.credential_id')) {
			throw new ApiError('bad_request', 'This passkey is already registered');
		}
		throw error;
	}
	return { id: info.credential.id };
}

// ---------------------------------------------------------------------------
// Management

export async function listPasskeys(db: D1Database, session: SessionRecord): Promise<PasskeyDto[]> {
	const { results } = await db
		.prepare(
			`SELECT credential_id, name, created_at, last_used_at, backed_up, device_type
			 FROM passkeys WHERE revoked_at IS NULL ORDER BY created_at`
		)
		.all<{
			credential_id: string;
			name: string;
			created_at: number;
			last_used_at: number | null;
			backed_up: number;
			device_type: string;
		}>();
	return results.map((r) => ({
		id: r.credential_id,
		name: r.name,
		createdAt: toIso(r.created_at),
		lastUsedAt: toIso(r.last_used_at),
		backedUp: r.backed_up === 1,
		deviceType: r.device_type,
		current: r.credential_id === session.credentialId
	}));
}

export async function renamePasskey(db: D1Database, credentialId: string, name: string) {
	const row = await db
		.prepare(
			'UPDATE passkeys SET name = ? WHERE credential_id = ? AND revoked_at IS NULL RETURNING credential_id'
		)
		.bind(name, credentialId)
		.first();
	if (!row) throw new ApiError('not_found', 'Passkey not found');
}

/** Revokes a passkey and every session created with it. The last passkey cannot be removed. */
export async function revokePasskey(
	db: D1Database,
	session: SessionRecord,
	credentialId: string,
	now: number
) {
	requireRecentReauth(session, now);
	const active = await db
		.prepare(
			'SELECT count(*) AS n, sum(credential_id = ?) AS target FROM passkeys WHERE revoked_at IS NULL'
		)
		.bind(credentialId)
		.first<{ n: number; target: number | null }>();
	if (!active?.target) throw new ApiError('not_found', 'Passkey not found');
	if (active.n <= 1) throw new ApiError('last_passkey', 'The last passkey cannot be removed');

	try {
		await db.batch([
			db
				.prepare(
					'UPDATE passkeys SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL'
				)
				.bind(now, credentialId),
			db.prepare(GUARD),
			// Race backstop: at least one active passkey must remain.
			db.prepare(
				'INSERT INTO tx_guard (ok) VALUES ((SELECT count(*) FROM passkeys WHERE revoked_at IS NULL) >= 1)'
			),
			db
				.prepare(
					'UPDATE sessions SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL'
				)
				.bind(now, credentialId),
			db.prepare(CLEAR_GUARD)
		]);
	} catch (error) {
		if (isGuardFailure(error))
			throw new ApiError('last_passkey', 'The last passkey cannot be removed');
		throw error;
	}
}

export async function listSessions(
	db: D1Database,
	session: SessionRecord,
	now: number
): Promise<SessionSummaryDto[]> {
	const { results } = await db
		.prepare(
			`SELECT id, user_agent, created_at, last_seen_at FROM sessions
			 WHERE revoked_at IS NULL AND idle_expires_at > ?1 AND absolute_expires_at > ?1
			 ORDER BY last_seen_at DESC LIMIT 100`
		)
		.bind(now)
		.all<{ id: string; user_agent: string; created_at: number; last_seen_at: number }>();
	return results.map((r) => ({
		id: r.id,
		userAgent: r.user_agent,
		createdAt: toIso(r.created_at),
		lastSeenAt: toIso(r.last_seen_at),
		current: r.id === session.id
	}));
}

export async function revokeSessionById(db: D1Database, sessionId: string, now: number) {
	const row = await db
		.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING id')
		.bind(now, sessionId)
		.first();
	if (!row) throw new ApiError('not_found', 'Session not found');
}

export async function revokeOtherSessions(db: D1Database, session: SessionRecord, now: number) {
	requireRecentReauth(session, now);
	await db
		.prepare('UPDATE sessions SET revoked_at = ? WHERE id <> ? AND revoked_at IS NULL')
		.bind(now, session.id)
		.run();
}
