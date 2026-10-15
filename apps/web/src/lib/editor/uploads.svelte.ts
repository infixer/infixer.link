/**
 * Image uploads from the editor (design §10.2, ADR 0012).
 *
 * 1. The image is shown immediately from an object URL and its Blob is stored in IndexedDB.
 * 2. PUT /api/owner/v1/assets/{id} → POST …/complete. Both are idempotent, so an interrupted
 *    upload is simply restarted (also after a reload, from IndexedDB).
 * 3. While a referenced image is not ready, autosave holds the page locally.
 */
import type { AssetDto } from '@infixer-link/contracts';
import type { CsrfSource } from './transport.ts';
import { localDb } from './local-db.ts';
import { uploadImage } from './upload-client.ts';

export const ACCEPTED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
export const MAX_BYTES = 10 * 1024 * 1024;

/** An image Blob kept in IndexedDB until the server has it (also used by the outbox sync). */
export interface StoredUpload {
	assetId: string;
	pageId: string;
	blob: Blob;
	name: string;
	createdAt: number;
}

export async function storedUploads(pageId?: string): Promise<StoredUpload[]> {
	const db = await localDb();
	return (
		pageId ? await db.getAllFromIndex('uploads', 'pageId', pageId) : await db.getAll('uploads')
	) as StoredUpload[];
}

export async function deleteStoredUpload(assetId: string): Promise<void> {
	await localDb()
		.then((db) => db.delete('uploads', assetId))
		.catch(() => {});
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
			stored = await storedUploads(this.pageId);
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

	private fail(assetId: string, error: string, retryable: boolean) {
		const state = this.states[assetId];
		if (state) this.states[assetId] = { ...state, status: 'failed', error, retryable };
		this.onChange();
	}

	private async run(assetId: string) {
		const item = this.blobs[assetId];
		if (!item) return;
		const result = await uploadImage(this.csrf, assetId, item.blob, item.name);
		if (!result.ok) return this.fail(assetId, result.error, result.retryable);
		this.onReady(result.asset);
		const state = this.states[assetId];
		delete this.states[assetId];
		delete this.blobs[assetId];
		if (state) setTimeout(() => URL.revokeObjectURL(state.preview), 10_000);
		await deleteStoredUpload(assetId);
		this.onChange();
	}
}
