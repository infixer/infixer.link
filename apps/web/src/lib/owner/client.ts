/**
 * Browser helpers for owner screens. @simplewebauthn/browser is imported lazily
 * so it never ships with public pages (design §9.3).
 */
import type { ApiErrorBody } from '@infixer-link/contracts';

export class OwnerApiError extends Error {
	constructor(
		readonly status: number,
		readonly body: ApiErrorBody | null
	) {
		super(body?.message ?? `HTTP ${status}`);
	}

	get code() {
		return this.body?.code;
	}
}

export async function api<T>(
	path: string,
	options: { method?: string; body?: unknown; csrf?: string } = {}
): Promise<T> {
	const headers: Record<string, string> = {};
	if (options.body !== undefined) headers['content-type'] = 'application/json';
	if (options.csrf) headers['x-csrf-token'] = options.csrf;
	const res = await fetch(path, {
		method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
		credentials: 'same-origin',
		cache: 'no-store'
	});
	const data = await res.json().catch(() => null);
	if (!res.ok) throw new OwnerApiError(res.status, data as ApiErrorBody | null);
	return data as T;
}

export function errorMessage(error: unknown): string {
	if (error instanceof OwnerApiError) return error.message;
	if (error instanceof Error && error.name === 'NotAllowedError') {
		return 'パスキーの操作がキャンセルされたか、時間切れになりました。';
	}
	return error instanceof Error ? error.message : String(error);
}

/** Login or re-authentication with a discoverable passkey. */
export async function passkeyAuthenticate(purpose: 'login' | 'reauth', csrf?: string) {
	const { startAuthentication } = await import('@simplewebauthn/browser');
	const { options } = await api<{
		options: Parameters<typeof startAuthentication>[0]['optionsJSON'];
	}>('/api/auth/v1/authentication/options', { body: { purpose }, csrf });
	const response = await startAuthentication({ optionsJSON: options });
	return api<{ authenticated: true; purpose: string }>('/api/auth/v1/authentication/verify', {
		body: { response },
		csrf
	});
}

type RegistrationOptions = Parameters<
	typeof import('@simplewebauthn/browser').startRegistration
>[0]['optionsJSON'];

/** First registration (setup / recovery) with a one-time setup code. */
export async function passkeySetup(token: string, name: string) {
	const { startRegistration } = await import('@simplewebauthn/browser');
	const { options } = await api<{ options: RegistrationOptions }>('/api/auth/v1/setup/options', {
		body: { token }
	});
	const response = await startRegistration({ optionsJSON: options });
	return api('/api/auth/v1/setup/verify', { body: { response, name } });
}

/** Additional passkey for a signed-in owner (requires recent re-authentication). */
export async function passkeyAdd(name: string, csrf: string) {
	const { startRegistration } = await import('@simplewebauthn/browser');
	const { options } = await api<{ options: RegistrationOptions }>(
		'/api/auth/v1/registration/options',
		{
			body: {},
			csrf
		}
	);
	const response = await startRegistration({ optionsJSON: options });
	return api('/api/auth/v1/registration/verify', { body: { response, name }, csrf });
}

/** Runs an action that may need re-authentication; confirms with a passkey once and retries. */
export async function withReauth<T>(csrf: string, action: () => Promise<T>): Promise<T> {
	try {
		return await action();
	} catch (error) {
		if (error instanceof OwnerApiError && error.code === 'reauth_required') {
			await passkeyAuthenticate('reauth', csrf);
			return action();
		}
		throw error;
	}
}
