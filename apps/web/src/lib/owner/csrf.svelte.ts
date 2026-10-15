/** Owner session state for a page view, created only after a positive session probe. */
import { fetchSession } from './session.ts';
import type { CsrfSource } from '../editor/transport.ts';

export class OwnerSession implements CsrfSource {
	csrfToken = $state('');
	signedIn = $state(true);

	constructor(csrfToken: string) {
		this.csrfToken = csrfToken;
	}

	get(): string {
		return this.csrfToken;
	}

	async refresh(): Promise<string | null> {
		const session = await fetchSession();
		if (!session.authenticated) {
			this.signedIn = false;
			return null;
		}
		this.signedIn = true;
		this.csrfToken = session.csrfToken;
		return session.csrfToken;
	}

	/** Returns an owner session when the visitor is signed in; anonymous visitors get null. */
	static async probe(): Promise<OwnerSession | null> {
		const session = await fetchSession();
		return session.authenticated ? new OwnerSession(session.csrfToken) : null;
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
