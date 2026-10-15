/**
 * API tokens for the CLI (design §9.6, ADR 0016).
 *
 * - Issued only from a cookie session that re-authenticated with a passkey in the last
 *   5 minutes; shown once. Only the SHA-256 is stored.
 * - Scopes: read / write / backup. Tokens can never manage passkeys, sessions or tokens.
 * - Every token expires (1–365 days); revoked on demand and on passkey recovery.
 */
import type { IssuedTokenDto, TokenDto, TokenScope } from '@infixer-link/contracts';
import { TOKEN_SCOPES } from '@infixer-link/contracts';
import { randomToken, sha256Hex } from '../crypto';
import { ApiError, toIso } from '../http';
import { requireRecentReauth, type SessionRecord } from './service';

const PREFIX = 'ifx_';
const DAY = 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export interface TokenRecord {
	id: string;
	scopes: TokenScope[];
}

interface Row {
	id: string;
	label: string;
	scopes: string;
	created_at: number;
	expires_at: number;
	last_used_at: number | null;
	revoked_at: number | null;
}

const parseScopes = (raw: string) =>
	raw.split(' ').filter((s): s is TokenScope => (TOKEN_SCOPES as readonly string[]).includes(s));

function toDto(r: Row): TokenDto {
	return {
		id: r.id,
		label: r.label,
		scopes: parseScopes(r.scopes),
		createdAt: toIso(r.created_at),
		expiresAt: toIso(r.expires_at),
		lastUsedAt: toIso(r.last_used_at),
		revoked: r.revoked_at !== null
	};
}

export async function issueToken(
	db: D1Database,
	session: SessionRecord,
	input: { label: string; scopes: TokenScope[]; expiresInDays: number },
	now: number
): Promise<IssuedTokenDto> {
	requireRecentReauth(session, now);
	const id = crypto.randomUUID();
	const token = `${PREFIX}${randomToken(32)}`;
	const row = await db
		.prepare(
			`INSERT INTO api_tokens (id, token_hash, owner_id, label, scopes, created_at, expires_at)
			 SELECT ?, ?, id, ?, ?, ?, ? FROM owner WHERE id = 1
			 RETURNING id, label, scopes, created_at, expires_at, last_used_at, revoked_at`
		)
		.bind(
			id,
			await sha256Hex(token),
			input.label,
			[...input.scopes].sort().join(' '),
			now,
			now + input.expiresInDays * DAY
		)
		.first<Row>();
	if (!row) throw new ApiError('internal_error', 'Owner not found');
	return { ...toDto(row), token };
}

export async function listTokens(db: D1Database): Promise<TokenDto[]> {
	const { results } = await db
		.prepare(
			`SELECT id, label, scopes, created_at, expires_at, last_used_at, revoked_at
			 FROM api_tokens ORDER BY created_at DESC LIMIT 100`
		)
		.all<Row>();
	return results.map(toDto);
}

export async function revokeToken(db: D1Database, id: string, now: number): Promise<void> {
	const row = await db
		.prepare(
			'UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING id'
		)
		.bind(now, id)
		.first();
	if (!row) throw new ApiError('not_found', 'Token not found');
}

/** Resolves a Bearer token to an active token, or null. */
export async function verifyToken(
	db: D1Database,
	token: string,
	now: number
): Promise<TokenRecord | null> {
	if (!token.startsWith(PREFIX) || token.length > 100) return null;
	const row = await db
		.prepare(
			`SELECT id, scopes, last_used_at FROM api_tokens
			 WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`
		)
		.bind(await sha256Hex(token), now)
		.first<{ id: string; scopes: string; last_used_at: number | null }>();
	if (!row) return null;
	if (row.last_used_at === null || now - row.last_used_at > TOUCH_INTERVAL_MS) {
		await db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').bind(now, row.id).run();
	}
	return { id: row.id, scopes: parseScopes(row.scopes) };
}
