/** IndexedDB-backed draft store (design §4.3, §4.4). Browser only. */
import { openDB, type IDBPDatabase } from 'idb';
import type { Draft, DraftStore } from './autosave.ts';

const DB_NAME = 'infixer-link';
const STORE = 'drafts';

let dbPromise: Promise<IDBPDatabase> | undefined;

function database() {
	dbPromise ??= openDB(DB_NAME, 1, {
		upgrade(db) {
			db.createObjectStore(STORE, { keyPath: 'pageId' });
		}
	});
	return dbPromise;
}

export const idbDraftStore: DraftStore = {
	async get(pageId) {
		return (await database()).get(STORE, pageId) as Promise<Draft | undefined>;
	},
	async put(draft) {
		// The transaction is awaited, so "端末に保存済み" is only shown after commit.
		await (await database()).put(STORE, draft);
	},
	async delete(pageId) {
		await (await database()).delete(STORE, pageId);
	}
};
