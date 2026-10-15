/**
 * One no-store session probe per page load (design §9.1). Anonymous visitors get
 * `{ authenticated: false }` without a DB lookup and never see owner UI or prompts.
 * The header and the page share the same probe.
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

let shared: Promise<SessionDto> | undefined;

/** Cached for the lifetime of the document; sign-in / sign-out do full page loads. */
export function sessionOnce(): Promise<SessionDto> {
	shared ??= fetchSession();
	return shared;
}
