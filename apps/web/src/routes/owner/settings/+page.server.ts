import { env } from 'cloudflare:workers';
import { redirect } from '@sveltejs/kit';
import { authConfig } from '#lib/server/config.ts';
import { getSession, listPasskeys, listSessions } from '#lib/server/auth/service.ts';
import { listTokens } from '#lib/server/auth/tokens.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ cookies, url }) => {
	const now = Date.now();
	const session = await getSession(env.DB, cookies.get(authConfig().sessionCookie), now);
	if (!session) {
		redirect(303, `/owner/login?returnTo=${encodeURIComponent(url.pathname)}`);
	}
	const [passkeys, sessions, tokens] = await Promise.all([
		listPasskeys(env.DB, session),
		listSessions(env.DB, session, now),
		listTokens(env.DB)
	]);
	const owner = await env.DB.prepare('SELECT user_handle FROM owner WHERE id = 1').first<{
		user_handle: string;
	}>();
	return {
		csrfToken: session.csrfToken,
		passkeys,
		sessions,
		tokens,
		// For the WebAuthn Signal API: lets the passkey manager hide removed credentials.
		rpId: authConfig().rpId,
		userHandle: owner?.user_handle ?? ''
	};
};
