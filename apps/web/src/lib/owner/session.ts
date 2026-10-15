/**
 * One no-store session probe per page view (design §9.1). Anonymous visitors get
 * `{ authenticated: false }` without a DB lookup and never see owner UI or prompts.
 */
import type { SessionDto } from '@infixer-link/contracts';

export async function fetchSession(): Promise<SessionDto> {
	try {
		const res = await fetch('/api/auth/v1/session', {
			credentials: 'same-origin',
			cache: 'no-store'
		});
		if (!res.ok) return { authenticated: false };
		return (await res.json()) as SessionDto;
	} catch {
		return { authenticated: false };
	}
}
