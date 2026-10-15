import { env } from 'cloudflare:workers';
import { redirect } from '@sveltejs/kit';
import { authConfig } from '#lib/server/config.ts';
import { getSession, listPasskeys, listSessions } from '#lib/server/auth/service.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ cookies, url }) => {
	const now = Date.now();
	const session = await getSession(env.DB, cookies.get(authConfig().sessionCookie), now);
	if (!session) {
		redirect(303, `/owner/login?returnTo=${encodeURIComponent(url.pathname)}`);
	}
	const [passkeys, sessions] = await Promise.all([
		listPasskeys(env.DB, session),
		listSessions(env.DB, session, now)
	]);
	return { csrfToken: session.csrfToken, passkeys, sessions };
};
