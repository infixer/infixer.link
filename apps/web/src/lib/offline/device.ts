/**
 * Remembers that the owner signed in on this device, so cached pages stay editable
 * offline and unsent drafts are looked after (design §4.4). It stays when the session
 * expires and is cleared only by the logout choice to delete this device's data. Only a flag: no token or credential is stored. While offline
 * the editor saves to IndexedDB; the first request after reconnecting refreshes the
 * session and CSRF token, and an expired session asks to sign in again.
 */
const KEY = 'infixer-link:owner-device';

export function rememberOwnerDevice() {
	try {
		localStorage.setItem(KEY, '1');
	} catch {
		// storage blocked: offline editing is simply not offered
	}
}

export function forgetOwnerDevice() {
	try {
		localStorage.removeItem(KEY);
	} catch {
		// ignore
	}
}

export function isOwnerDevice(): boolean {
	try {
		return localStorage.getItem(KEY) === '1';
	} catch {
		return false;
	}
}
