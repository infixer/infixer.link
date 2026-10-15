import { beforeEach, describe, expect, it } from 'vitest';
import type {
	CreateIntent,
	Draft,
	PendingMutation,
	SendResult,
	Transport
} from '../editor/autosave.ts';
import type { StoredUpload } from '../editor/uploads.svelte.ts';
import type { UploadResult } from '../editor/upload-client.ts';
import { syncOutbox, type OutboxDeps } from './outbox.ts';

class Store {
	drafts = new Map<string, Draft>();
	async get(id: string) {
		return structuredClone(this.drafts.get(id));
	}
	async put(d: Draft) {
		this.drafts.set(d.pageId, structuredClone(d));
	}
	async delete(id: string) {
		this.drafts.delete(id);
	}
	async all() {
		return [...this.drafts.values()].map((d) => structuredClone(d));
	}
}

class Server implements Transport {
	revisions = new Map<string, number>();
	calls: { pageId: string; base: number; mutation: PendingMutation; create?: CreateIntent }[] = [];
	next: SendResult | null = null;
	async save(pageId: string, base: number, mutation: PendingMutation, create?: CreateIntent) {
		this.calls.push({ pageId, base, mutation, create });
		if (this.next) return this.next;
		const rev = this.revisions.get(pageId) ?? 0;
		if (rev !== base) return { ok: false as const, kind: 'conflict' as const };
		this.revisions.set(pageId, rev + 1);
		return { ok: true as const, revision: rev + 1 };
	}
}

const draft = (pageId: string, over: Partial<Draft> = {}): Draft => ({
	pageId,
	title: pageId,
	source: `${pageId} の本文`,
	baseRevision: 1,
	base: { title: pageId, source: '' },
	savedAt: 0,
	...over
});

let store: Store;
let server: Server;
let uploads: StoredUpload[];
let uploadResult: UploadResult;
let busy: Set<string>;
let deps: OutboxDeps;

beforeEach(() => {
	store = new Store();
	server = new Server();
	uploads = [];
	uploadResult = { ok: true, asset: {} as never };
	busy = new Set();
	let n = 0;
	deps = {
		store,
		transport: server,
		uploads: {
			list: async (pageId) => uploads.filter((u) => u.pageId === pageId),
			upload: async () => uploadResult,
			remove: async (id) => {
				uploads = uploads.filter((u) => u.assetId !== id);
			}
		},
		withPageLock: async (pageId, fn) => (busy.has(pageId) ? 'busy' : fn()),
		newId: () => `m${++n}`
	};
});

describe('syncOutbox', () => {
	it('sends every unsent draft oldest first and removes it after the server confirmed', async () => {
		server.revisions.set('a', 1).set('b', 1);
		await store.put(draft('b', { savedAt: 2 }));
		await store.put(draft('a', { savedAt: 1 }));
		const report = await syncOutbox(deps);
		expect(report).toEqual({ sent: 2, conflicts: 0, blocked: 0, busy: 0, stopped: null });
		expect(server.calls.map((c) => c.pageId)).toEqual(['a', 'b']);
		expect(store.drafts.size).toBe(0);
	});

	it('reuses the pending mutationId of an identical retry', async () => {
		server.revisions.set('a', 1);
		await store.put(
			draft('a', { pending: { title: 'a', source: 'a の本文', mutationId: 'kept' } })
		);
		await syncOutbox(deps);
		expect(server.calls[0]!.mutation.mutationId).toBe('kept');
	});

	it('creates pages made on this device', async () => {
		await store.put(draft('new', { baseRevision: 0, create: { dailyDate: '2026-10-16' } }));
		await syncOutbox(deps);
		expect(server.calls[0]).toMatchObject({ base: 0, create: { dailyDate: '2026-10-16' } });
		expect(store.drafts.size).toBe(0);
	});

	it('keeps conflicting drafts, flagged, with their content', async () => {
		server.revisions.set('a', 5); // changed on another device
		await store.put(draft('a'));
		const report = await syncOutbox(deps);
		expect(report.conflicts).toBe(1);
		expect(store.drafts.get('a')).toMatchObject({ conflict: true, source: 'a の本文' });
		// Not retried silently on the next run.
		await syncOutbox(deps);
		expect(server.calls).toHaveLength(1);
	});

	it('records which daily page already exists when an offline create collides', async () => {
		server.next = { ok: false, kind: 'conflict', existingPageId: 'theirs' };
		await store.put(draft('mine', { baseRevision: 0, create: { dailyDate: '2026-10-16' } }));
		await syncOutbox(deps);
		expect(store.drafts.get('mine')).toMatchObject({ conflict: true, existingPageId: 'theirs' });
	});

	it('stops on network or session trouble and keeps everything', async () => {
		await store.put(draft('a', { savedAt: 1 }));
		await store.put(draft('b', { savedAt: 2 }));
		server.next = { ok: false, kind: 'offline' };
		expect((await syncOutbox(deps)).stopped).toBe('offline');
		expect(server.calls).toHaveLength(1);
		server.next = { ok: false, kind: 'auth' };
		expect((await syncOutbox(deps)).stopped).toBe('auth');
		expect(store.drafts.size).toBe(2);
		expect(store.drafts.get('a')!.pending).toBeDefined();
	});

	it('skips pages open in an editor', async () => {
		busy.add('a');
		await store.put(draft('a'));
		expect((await syncOutbox(deps)).busy).toBe(1);
		expect(server.calls).toHaveLength(0);
	});

	it('uploads referenced images first and never publishes a page before they are stored', async () => {
		server.revisions.set('a', 1);
		uploads = [
			{ assetId: 'img1', pageId: 'a', blob: new Blob(), name: 'x.png', createdAt: 0 },
			{ assetId: 'gone', pageId: 'a', blob: new Blob(), name: 'y.png', createdAt: 0 }
		];
		await store.put(draft('a', { source: '写真\n[asset:img1]' }));
		uploadResult = { ok: false, retryable: true, error: 'offline' };
		expect((await syncOutbox(deps)).stopped).toBe('offline');
		expect(server.calls).toHaveLength(0);

		uploadResult = { ok: true, asset: {} as never };
		expect((await syncOutbox(deps)).sent).toBe(1);
		expect(uploads.map((u) => u.assetId)).toEqual(['gone']); // not referenced: left alone
	});

	it('marks a draft as waiting when its image is rejected', async () => {
		uploads = [{ assetId: 'bad', pageId: 'a', blob: new Blob(), name: 'x', createdAt: 0 }];
		await store.put(draft('a', { source: '[asset:bad]' }));
		uploadResult = { ok: false, retryable: false, error: '対応していない形式です' };
		expect((await syncOutbox(deps)).blocked).toBe(1);
		expect(store.drafts.get('a')!.error).toContain('対応していない形式です');
		expect(server.calls).toHaveLength(0);
	});

	it('keeps newer text written while the request was in flight', async () => {
		server.revisions.set('a', 1);
		await store.put(draft('a', { source: 'v1' }));
		const save = server.save.bind(server);
		server.save = async (...args) => {
			const r = await save(...args);
			await store.put(draft('a', { source: 'v2' })); // another tab kept typing
			return r;
		};
		await syncOutbox(deps);
		expect(store.drafts.get('a')).toMatchObject({
			source: 'v2',
			baseRevision: 2,
			base: { title: 'a', source: 'v1' },
			pending: undefined
		});
	});

	it('drops drafts that only repeat the server content', async () => {
		await store.put(draft('a', { source: '', base: { title: 'a', source: '' } }));
		await syncOutbox(deps);
		expect(server.calls).toHaveLength(0);
		expect(store.drafts.size).toBe(0);
	});
});
