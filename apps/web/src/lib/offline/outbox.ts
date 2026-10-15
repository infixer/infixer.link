/**
 * Background sync of everything this device has not sent yet (design §4.4, Phase 6).
 *
 * Drafts in IndexedDB are the outbox: one per page, holding the content, the server
 * revision it is based on and the pending mutation (same mutationId on every retry).
 * The editor sends the draft of the page that is open; this runner sends the others when
 * the app starts, the network returns or the tab becomes visible again — no Background
 * Sync API is needed (iOS has none). A per-page lock keeps it away from open editors.
 *
 * Nothing is dropped: conflicts are flagged and kept for the owner to resolve, rejected
 * images and invalid drafts wait for an edit, and network / session trouble stops the run.
 */
import type {
	Draft,
	DraftStore,
	PendingMutation,
	Snapshot,
	Transport
} from '../editor/autosave.ts';
import type { StoredUpload } from '../editor/uploads.svelte.ts';
import type { UploadResult } from '../editor/upload-client.ts';

export interface OutboxDeps {
	store: DraftStore & { all(): Promise<Draft[]> };
	transport: Transport;
	uploads: {
		list(pageId: string): Promise<StoredUpload[]>;
		upload(u: StoredUpload): Promise<UploadResult>;
		remove(assetId: string): Promise<void>;
	};
	/** Runs `fn` only if nobody else (an open editor, another tab) holds the page. */
	withPageLock<T>(pageId: string, fn: () => Promise<T>): Promise<T | 'busy'>;
	newId(): string;
}

export interface OutboxReport {
	sent: number;
	/** Rejected as conflicting: kept until the owner chooses. */
	conflicts: number;
	/** Waiting for the owner (rejected image, invalid content). */
	blocked: number;
	/** Open in an editor right now (it sends them itself). */
	busy: number;
	/** The run stopped early. */
	stopped: 'offline' | 'auth' | null;
}

const same = (a: Snapshot, b: Snapshot) => a.title === b.title && a.source === b.source;

type Outcome = 'sent' | 'conflict' | 'blocked' | 'nothing' | 'offline' | 'auth';

async function sendOne(deps: OutboxDeps, pageId: string): Promise<Outcome> {
	const draft = await deps.store.get(pageId);
	if (!draft) return 'nothing';
	if (draft.conflict) return 'conflict';

	// Images first: a page is never published while it references an image not uploaded.
	for (const upload of await deps.uploads.list(pageId)) {
		if (!draft.source.includes(`[asset:${upload.assetId}]`)) continue;
		const result = await deps.uploads.upload(upload);
		if (result.ok) {
			await deps.uploads.remove(upload.assetId);
			continue;
		}
		if (result.auth) return 'auth';
		if (result.retryable) return 'offline';
		await deps.store.put({ ...draft, error: `画像を送信できません：${result.error}` });
		return 'blocked';
	}

	if (!draft.create && !draft.pending && draft.base && same(draft, draft.base)) {
		await deps.store.delete(pageId); // nothing left to send
		return 'nothing';
	}

	const mutation: PendingMutation =
		draft.pending && same(draft.pending, draft)
			? draft.pending
			: { title: draft.title, source: draft.source, mutationId: deps.newId() };
	await deps.store.put({ ...draft, pending: mutation, error: undefined });

	let result;
	try {
		result = await deps.transport.save(pageId, draft.baseRevision, mutation, draft.create);
	} catch {
		return 'offline';
	}
	if (result.ok) {
		const fresh = await deps.store.get(pageId);
		if (!fresh || same(fresh, mutation)) {
			await deps.store.delete(pageId);
		} else {
			// Edited again meanwhile (e.g. in another tab): keep the newer text on the new base.
			await deps.store.put({
				...fresh,
				baseRevision: result.revision,
				base: { title: mutation.title, source: mutation.source },
				pending: undefined,
				create: undefined
			});
		}
		return 'sent';
	}
	switch (result.kind) {
		case 'conflict':
			await deps.store.put({
				...draft,
				pending: undefined,
				conflict: true,
				existingPageId: result.existingPageId
			});
			return 'conflict';
		case 'auth':
			return 'auth';
		case 'offline':
		case 'server':
			return 'offline';
		case 'too-large':
		case 'invalid':
			await deps.store.put({
				...draft,
				pending: undefined,
				error: result.message ?? '保存できない内容です'
			});
			return 'blocked';
	}
}

let running: Promise<OutboxReport> | null = null;

/** Sends all drafts (oldest first). Concurrent calls share one run. */
export function syncOutbox(deps: OutboxDeps): Promise<OutboxReport> {
	running ??= run(deps).finally(() => {
		running = null;
	});
	return running;
}

async function run(deps: OutboxDeps): Promise<OutboxReport> {
	const report: OutboxReport = { sent: 0, conflicts: 0, blocked: 0, busy: 0, stopped: null };
	const drafts = (await deps.store.all()).sort((a, b) => a.savedAt - b.savedAt);
	for (const draft of drafts) {
		const outcome = await deps.withPageLock(draft.pageId, () => sendOne(deps, draft.pageId));
		switch (outcome) {
			case 'busy':
				report.busy++;
				break;
			case 'sent':
				report.sent++;
				break;
			case 'conflict':
				report.conflicts++;
				break;
			case 'blocked':
				report.blocked++;
				break;
			case 'offline':
			case 'auth':
				report.stopped = outcome;
				return report;
		}
	}
	return report;
}
