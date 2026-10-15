/**
 * Setup / recovery grants (design §9.2, §9.5).
 *
 * A grant is minted by the operator with Cloudflare admin rights (scripts/owner-grant.ts
 * runs `wrangler d1 execute`). Only the SHA-256 of the token is stored. Pure module:
 * also imported by the Node script, so it must not import `cloudflare:workers`.
 */
import { randomToken, sha256Hex } from '../crypto.ts';

export type GrantPurpose = 'setup' | 'recovery';

export const GRANT_TTL_MS = 10 * 60 * 1000;

export interface MintedGrant {
	token: string;
	statements: string[];
}

/** Values are generated here (hex / base64url / integers), so inlining them in SQL is safe. */
export async function mintGrant(purpose: GrantPurpose, now: number): Promise<MintedGrant> {
	const token = randomToken(32);
	const tokenHash = await sha256Hex(token);
	const grantId = crypto.randomUUID();
	const userHandle = randomToken(32);
	return {
		token,
		statements: [
			// The single owner row is created once; its WebAuthn user handle never changes.
			`INSERT INTO owner (id, user_handle, created_at) VALUES (1, '${userHandle}', ${now}) ON CONFLICT (id) DO NOTHING`,
			`INSERT INTO setup_grants (id, token_hash, purpose, created_at, expires_at) VALUES ('${grantId}', '${tokenHash}', '${purpose}', ${now}, ${now + GRANT_TTL_MS})`
		]
	};
}
