/**
 * One image upload: PUT the bytes, then complete (ADR 0012). Both steps are idempotent,
 * so the same asset id can be retried after any interruption. Shared by the editor
 * (uploads.svelte.ts) and the background outbox sync (offline/outbox.ts).
 */
import type { ApiErrorBody, AssetDto } from '@infixer-link/contracts';
import type { CsrfSource } from './transport.ts';

export type UploadResult =
	| { ok: true; asset: AssetDto }
	/** `retryable`: network / server / session trouble; otherwise the image itself was rejected. */
	| { ok: false; retryable: boolean; error: string; auth?: boolean };

async function send(csrf: CsrfSource, path: string, init: RequestInit): Promise<Response> {
	const run = (token: string) =>
		fetch(path, {
			...init,
			credentials: 'same-origin',
			headers: { ...(init.headers as Record<string, string>), 'x-csrf-token': token }
		});
	let res = await run(csrf.get());
	if (res.status === 403) {
		const token = await csrf.refresh();
		if (token) res = await run(token);
	}
	return res;
}

export async function uploadImage(
	csrf: CsrfSource,
	assetId: string,
	blob: Blob,
	name: string
): Promise<UploadResult> {
	try {
		const put = await send(csrf, `/api/owner/v1/assets/${assetId}`, {
			method: 'PUT',
			body: blob,
			headers: { 'content-type': blob.type, 'x-file-name': encodeURIComponent(name) }
		});
		if (!put.ok) {
			const body = (await put.json().catch(() => null)) as ApiErrorBody | null;
			return {
				ok: false,
				error: body?.message ?? '画像を送信できませんでした',
				retryable: put.status >= 500 || put.status === 401 || put.status === 403,
				auth: put.status === 401 || put.status === 403
			};
		}
		const done = await send(csrf, `/api/owner/v1/assets/${assetId}/complete`, {
			method: 'POST',
			body: '{}',
			headers: { 'content-type': 'application/json' }
		});
		const body = (await done.json().catch(() => null)) as (AssetDto & Partial<ApiErrorBody>) | null;
		if (!done.ok || !body || body.status !== 'ready') {
			return {
				ok: false,
				error: body?.message ?? '画像を確定できませんでした',
				retryable: done.status >= 500 || done.status === 401 || done.status === 403,
				auth: done.status === 401 || done.status === 403
			};
		}
		return { ok: true, asset: body };
	} catch {
		return {
			ok: false,
			retryable: true,
			error: '通信できませんでした。接続が戻ったら再送信してください'
		};
	}
}
