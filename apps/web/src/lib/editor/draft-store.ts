/** IndexedDB-backed draft store (design §4.3, §4.4). Browser only. */
import type { Draft, DraftStore } from './autosave.ts';
import { localDb } from './local-db.ts';

export const idbDraftStore: DraftStore & { all(): Promise<Draft[]> } = {
	async get(pageId) {
		return (await localDb()).get('drafts', pageId) as Promise<Draft | undefined>;
	},
	async put(draft) {
		// The transaction is awaited, so "端末に保存済み" is only shown after commit.
		await (await localDb()).put('drafts', draft);
	},
	async delete(pageId) {
		await (await localDb()).delete('drafts', pageId);
	},
	async all() {
		return (await (await localDb()).getAll('drafts')) as Draft[];
	}
};
