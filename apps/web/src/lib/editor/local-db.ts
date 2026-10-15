/** The browser's IndexedDB for drafts and unsent images (design §4.3, §10.2). */
import { openDB, type IDBPDatabase } from 'idb';

let dbPromise: Promise<IDBPDatabase> | undefined;

export function localDb() {
	dbPromise ??= openDB('infixer-link', 2, {
		upgrade(db, oldVersion) {
			if (oldVersion < 1) db.createObjectStore('drafts', { keyPath: 'pageId' });
			if (oldVersion < 2) {
				const uploads = db.createObjectStore('uploads', { keyPath: 'assetId' });
				uploads.createIndex('pageId', 'pageId');
			}
		}
	});
	return dbPromise;
}
