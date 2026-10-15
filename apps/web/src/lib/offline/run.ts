/** Browser wiring of the outbox sync (IndexedDB, HTTP, Web Locks). */
import { httpTransport, type CsrfSource } from '../editor/transport.ts';
import { idbDraftStore } from '../editor/draft-store.ts';
import { deleteStoredUpload, storedUploads } from '../editor/uploads.svelte.ts';
import { uploadImage } from '../editor/upload-client.ts';
import { syncOutbox, type OutboxReport } from './outbox.ts';
import { withPageLock } from './locks.ts';

export function runOutbox(csrf: CsrfSource): Promise<OutboxReport> {
	return syncOutbox({
		store: idbDraftStore,
		transport: httpTransport(csrf),
		uploads: {
			list: (pageId) => storedUploads(pageId).catch(() => []),
			upload: (u) => uploadImage(csrf, u.assetId, u.blob, u.name),
			remove: deleteStoredUpload
		},
		withPageLock,
		newId: () => crypto.randomUUID()
	});
}

/** Number of pages with changes not on the server yet (any reason). */
export async function unsentCount(): Promise<number> {
	try {
		return (await idbDraftStore.all()).length;
	} catch {
		return 0;
	}
}
