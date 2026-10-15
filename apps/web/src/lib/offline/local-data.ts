/** All unsent data on this device: export it, or delete it (logout choice, design §4.4). */
import { idbDraftStore } from '../editor/draft-store.ts';
import { localDb } from '../editor/local-db.ts';
import { storedUploads } from '../editor/uploads.svelte.ts';
import { forgetOwnerDevice } from './device.ts';

export async function localSummary(): Promise<{ drafts: number; images: number }> {
	try {
		const [drafts, images] = await Promise.all([idbDraftStore.all(), storedUploads()]);
		return { drafts: drafts.length, images: images.length };
	} catch {
		return { drafts: 0, images: 0 };
	}
}

const dataUrl = (blob: Blob) =>
	new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});

/** One JSON file with every draft and every image not uploaded yet (as data URLs). */
export async function downloadLocalData() {
	const [drafts, uploads] = await Promise.all([idbDraftStore.all(), storedUploads()]);
	const images = await Promise.all(
		uploads.map(async (u) => ({
			assetId: u.assetId,
			pageId: u.pageId,
			name: u.name,
			data: await dataUrl(u.blob)
		}))
	);
	const text = JSON.stringify(
		{ exportedAt: new Date().toISOString(), format: 'infixer-link-drafts-v1', drafts, images },
		null,
		2
	);
	const a = document.createElement('a');
	a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
	a.download = `infixer-link-drafts-${Date.now()}.json`;
	a.click();
	URL.revokeObjectURL(a.href);
}

/** Deletes drafts, images, cached pages, the owner-device flag and the Service Worker. */
export async function deleteLocalData() {
	const db = await localDb();
	await db.clear('drafts');
	await db.clear('uploads');
	if ('caches' in self) {
		for (const key of await caches.keys()) if (key.startsWith('pages-')) await caches.delete(key);
	}
	forgetOwnerDevice();
	for (const registration of (await navigator.serviceWorker?.getRegistrations?.()) ?? []) {
		await registration.unregister();
	}
}
