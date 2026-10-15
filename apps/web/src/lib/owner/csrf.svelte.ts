/** Owner session state for a page view, created only after a positive session probe. */
import { fetchSession, sessionOnce } from './session.ts';
import type { CsrfSource } from '../editor/transport.ts';
import { isOwnerDevice, rememberOwnerDevice } from '../offline/device.ts';

export class OwnerSession implements CsrfSource {
	csrfToken = $state('');
	signedIn = $state(true);
	/** Started without reaching the server (offline on a device the owner signed in on). */
	offline = $state(false);

	constructor(csrfToken: string, offline = false) {
		this.csrfToken = csrfToken;
		this.offline = offline;
	}

	get(): string {
		return this.csrfToken;
	}

	async refresh(): Promise<string | null> {
		const session = await fetchSession();
		if (!session.authenticated) {
			// Unreachable is not "signed out": keep the state and let the caller retry later.
			if (!session.unreachable) this.signedIn = false;
			return null;
		}
		this.signedIn = true;
		this.offline = false;
		this.csrfToken = session.csrfToken;
		return session.csrfToken;
	}

	/**
	 * Returns an owner session when the visitor is signed in; anonymous visitors get null.
	 * Offline, a device the owner signed in on gets an offline session (empty CSRF token;
	 * the first request after reconnecting refreshes it, ADR 0015).
	 */
	static async probe(): Promise<OwnerSession | null> {
		const session = await sessionOnce();
		if (session.authenticated) {
			rememberOwnerDevice();
			return new OwnerSession(session.csrfToken);
		}
		if (session.unreachable) return isOwnerDevice() ? new OwnerSession('', true) : null;
		// Signed out or expired: the device flag stays (drafts may still wait to be sent);
		// only the logout choice "delete" forgets it.
		return null;
	}
}

/** JSON call with CSRF and one refresh-and-retry on csrf_failed. */
export async function ownerFetch(
	owner: OwnerSession,
	path: string,
	init: { method: string; body?: unknown }
) {
	const send = (token: string) =>
		fetch(path, {
			method: init.method,
			headers: { 'content-type': 'application/json', 'x-csrf-token': token },
			credentials: 'same-origin',
			cache: 'no-store',
			body: JSON.stringify(init.body ?? {})
		});
	let res = await send(owner.get());
	if (res.status === 403) {
		const token = await owner.refresh();
		if (token) res = await send(token);
	}
	return res;
}
