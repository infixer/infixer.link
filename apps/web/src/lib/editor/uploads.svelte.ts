/**
 * Image uploads from the editor (design §10.2, ADR 0012).
 *
 * 1. The image is shown immediately from an object URL and its Blob is stored in IndexedDB.
 * 2. PUT /api/owner/v1/assets/{id} → POST …/complete. Both are idempotent, so an interrupted
 *    upload is simply restarted (also after a reload, from IndexedDB).
 * 3. While a referenced image is not ready, autosave holds the page locally.
 */
import type { ApiErrorBody, AssetDto } from '@infixer-link/contracts';
import type { CsrfSource } from './transport.ts';
import { localDb } from './local-db.ts';

export const ACCEPTED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
export const MAX_BYTES = 10 * 1024 * 1024;

interface StoredUpload {
	assetId: string;
	pageId: string;
	blob: Blob;
	name: string;
	createdAt: number;
}

export interface UploadState {
	status: 'uploading' | 'failed';
	/** Object URL of the local Blob, for the preview while uploading. */
	preview: string;
	error?: string;
	/** Permanent failures (format / size) cannot be retried. */
	retryable: boolean;
}

export class Uploads {
	states = $state<Record<string, UploadState>>({});
	private blobs: Record<string, { blob: Blob; name: string }> = {};

	constructor(
		private readonly pageId: string,
		private readonly csrf: CsrfSource,
		private readonly onReady: (asset: AssetDto) => void,
		private readonly onChange: () => void
	) {}

	/** Client-side checks give an immediate message; the server re-validates everything. */
	static check(file: Blob): string | null {
		if (/heic|heif|avif/i.test(file.type)) {
			return 'HEIC / AVIF にはまだ対応していません。JPEG で書き出してから貼り付けてください';
		}
		if (!ACCEPTED.includes(file.type))
			return '対応していない形式です（JPEG / PNG / GIF / WebP のみ）';
		if (file.size > MAX_BYTES) return '画像は 10MiB までです';
		return null;
	}

	/** Starts uploading a new image and returns its asset id (to insert as [asset:id]). */
	add(file: Blob, name = 'image'): string {
		const assetId = crypto.randomUUID();
		this.blobs[assetId] = { blob: file, name };
		this.states[assetId] = {
			status: 'uploading',
			preview: URL.createObjectURL(file),
			retryable: true
		};
		void localDb()
			.then((db) =>
				db.put('uploads', {
					assetId,
					pageId: this.pageId,
					blob: file,
					name,
					createdAt: Date.now()
				} satisfies StoredUpload)
			)
			.catch(() => {
				// Storage full / unavailable: the upload continues from memory.
			});
		void this.run(assetId);
		return assetId;
	}

	/** Restarts uploads left over from a previous visit for images still in the document. */
	async resume(source: string) {
		let stored: StoredUpload[];
		try {
			stored = (await (
				await localDb()
			).getAllFromIndex('uploads', 'pageId', this.pageId)) as StoredUpload[];
		} catch {
			return;
		}
		for (const u of stored) {
			if (!source.includes(`[asset:${u.assetId}]`) || this.states[u.assetId]) continue;
			this.blobs[u.assetId] = { blob: u.blob, name: u.name };
			this.states[u.assetId] = {
				status: 'uploading',
				preview: URL.createObjectURL(u.blob),
				retryable: true
			};
			void this.run(u.assetId);
		}
		this.onChange();
	}

	retry(assetId: string) {
		const state = this.states[assetId];
		if (!state || state.status !== 'failed' || !state.retryable) return;
		this.states[assetId] = { ...state, status: 'uploading', error: undefined };
		void this.run(assetId);
	}

	/** True while the source references an image that is not uploaded yet. */
	isPending(source: string): boolean {
		return Object.keys(this.states).some((id) => source.includes(`[asset:${id}]`));
	}

	preview(assetId: string): UploadState | undefined {
		return this.states[assetId];
	}

	dispose() {
		for (const s of Object.values(this.states)) URL.revokeObjectURL(s.preview);
	}

	private async send(path: string, init: RequestInit): Promise<Response> {
		const run = (token: string) =>
			fetch(path, {
				...init,
				credentials: 'same-origin',
				headers: { ...(init.headers as Record<string, string>), 'x-csrf-token': token }
			});
		let res = await run(this.csrf.get());
		if (res.status === 403) {
			const token = await this.csrf.refresh();
			if (token) res = await run(token);
		}
		return res;
	}

	private fail(assetId: string, error: string, retryable: boolean) {
		const state = this.states[assetId];
		if (state) this.states[assetId] = { ...state, status: 'failed', error, retryable };
		this.onChange();
	}

	private async run(assetId: string) {
		const item = this.blobs[assetId];
		if (!item) return;
		try {
			const put = await this.send(`/api/owner/v1/assets/${assetId}`, {
				method: 'PUT',
				body: item.blob,
				headers: { 'content-type': item.blob.type, 'x-file-name': encodeURIComponent(item.name) }
			});
			if (!put.ok) {
				const body = (await put.json().catch(() => null)) as ApiErrorBody | null;
				return this.fail(
					assetId,
					body?.message ?? '画像を送信できませんでした',
					put.status >= 500 || put.status === 401
				);
			}
			const done = await this.send(`/api/owner/v1/assets/${assetId}/complete`, {
				method: 'POST',
				body: '{}',
				headers: { 'content-type': 'application/json' }
			});
			const body = (await done.json().catch(() => null)) as
				(AssetDto & Partial<ApiErrorBody>) | null;
			if (!done.ok || !body || body.status !== 'ready') {
				return this.fail(
					assetId,
					body?.message ?? '画像を確定できませんでした',
					done.status >= 500
				);
			}
			this.onReady(body);
			const state = this.states[assetId];
			delete this.states[assetId];
			delete this.blobs[assetId];
			if (state) setTimeout(() => URL.revokeObjectURL(state.preview), 10_000);
			await localDb()
				.then((db) => db.delete('uploads', assetId))
				.catch(() => {});
			this.onChange();
		} catch {
			this.fail(assetId, '通信できませんでした。接続が戻ったら再送信してください', true);
		}
	}
}
