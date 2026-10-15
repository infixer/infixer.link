/** Server transport for autosave: PUT /api/owner/v1/pages/:id with CSRF and error mapping. */
import type { ApiErrorBody } from '@infixer-link/contracts';
import type { PendingMutation, SendResult, Transport } from './autosave.ts';

export interface CsrfSource {
	get(): string;
	/** Re-reads the session; returns null when no longer signed in. */
	refresh(): Promise<string | null>;
}

async function put(pageId: string, csrf: string, baseRevision: number, m: PendingMutation) {
	return fetch(`/api/owner/v1/pages/${pageId}`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
		credentials: 'same-origin',
		cache: 'no-store',
		body: JSON.stringify({
			baseRevision,
			mutationId: m.mutationId,
			title: m.title,
			format: 'link-text-v1',
			source: m.source
		})
	});
}

export function httpTransport(csrf: CsrfSource): Transport {
	return {
		async save(pageId, baseRevision, mutation): Promise<SendResult> {
			let res: Response;
			try {
				res = await put(pageId, csrf.get(), baseRevision, mutation);
				if (res.status === 403) {
					const body = (await res
						.clone()
						.json()
						.catch(() => null)) as ApiErrorBody | null;
					if (body?.code === 'csrf_failed') {
						const token = await csrf.refresh();
						if (!token) return { ok: false, kind: 'auth' };
						res = await put(pageId, token, baseRevision, mutation);
					}
				}
			} catch {
				return { ok: false, kind: 'offline' };
			}
			if (res.ok) {
				const body = (await res.json()) as { revision: number };
				return { ok: true, revision: body.revision };
			}
			const error = (await res.json().catch(() => null)) as ApiErrorBody | null;
			switch (true) {
				case res.status === 401 || res.status === 403:
					return { ok: false, kind: 'auth' };
				case error?.code === 'revision_conflict' || error?.code === 'page_deleted':
					return {
						ok: false,
						kind: 'conflict',
						currentRevision: error?.details?.currentRevision as number | undefined
					};
				case res.status === 413:
					return { ok: false, kind: 'too-large', message: error?.message };
				case res.status === 409 || res.status === 422 || res.status === 400:
					return { ok: false, kind: 'invalid', message: error?.message };
				default:
					return { ok: false, kind: 'server' };
			}
		}
	};
}
