/**
 * One no-store session probe per page load (design §9.1). Anonymous visitors get
 * `{ authenticated: false }` without a DB lookup and never see owner UI or prompts.
 * The header and the page share the same probe.
 */
import type { SessionDto } from '@infixer-link/contracts';

/** `unreachable`: the server could not be asked (offline), as opposed to "not signed in". */
export type ProbedSession = SessionDto & { unreachable?: true };

export async function fetchSession(): Promise<ProbedSession> {
	try {
		const res = await fetch('/api/auth/v1/session', {
			credentials: 'same-origin',
			cache: 'no-store'
		});
		if (!res.ok) return { authenticated: false, unreachable: true };
		return (await res.json()) as SessionDto;
	} catch {
		return { authenticated: false, unreachable: true };
	}
}

let shared: Promise<ProbedSession> | undefined;

/** Cached for the lifetime of the document; sign-in / sign-out do full page loads. */
export function sessionOnce(): Promise<ProbedSession> {
	shared ??= fetchSession();
	return shared;
}
