import { describe, expect, it } from 'vitest';
import {
	Autosave,
	restore,
	type Clock,
	type Draft,
	type DraftStore,
	type PendingMutation,
	type SendResult,
	type ServerPage
} from './autosave';

class FakeClock implements Clock {
	ms = 0;
	private timers = new Map<number, { at: number; fn: () => void }>();
	private seq = 0;
	now = () => this.ms;
	setTimeout = (fn: () => void, ms: number) => {
		const id = ++this.seq;
		this.timers.set(id, { at: this.ms + ms, fn });
		return id;
	};
	clearTimeout = (id: unknown) => {
		this.timers.delete(id as number);
	};
	/** Advances time, running due timers and letting their promises settle. */
	async advance(ms: number) {
		const end = this.ms + ms;
		for (;;) {
			const due = [...this.timers]
				.filter(([, t]) => t.at <= end)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			this.timers.delete(due[0]);
			this.ms = due[1].at;
			due[1].fn();
			await flush();
		}
		this.ms = end;
		await flush();
	}
}

const flush = async () => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

class MemoryStore implements DraftStore {
	drafts = new Map<string, Draft>();
	failPut = false;
	async get(id: string) {
		return this.drafts.get(id);
	}
	async put(d: Draft) {
		if (this.failPut) throw new Error('QuotaExceededError');
		this.drafts.set(d.pageId, structuredClone(d));
	}
	async delete(id: string) {
		this.drafts.delete(id);
	}
}

class FakeServer {
	revision = 1;
	page = { title: 't', source: '' };
	calls: { base: number; mutation: PendingMutation }[] = [];
	applied = new Map<string, number>();
	mode: 'ok' | 'offline' | 'auth' | 'server' | 'lose-response' = 'ok';
	gate: Promise<void> | null = null;

	save = async (_id: string, base: number, mutation: PendingMutation): Promise<SendResult> => {
		this.calls.push({ base, mutation: { ...mutation } });
		if (this.gate) await this.gate;
		if (this.mode === 'offline') return { ok: false, kind: 'offline' };
		if (this.mode === 'auth') return { ok: false, kind: 'auth' };
		if (this.mode === 'server') return { ok: false, kind: 'server' };
		const replay = this.applied.get(mutation.mutationId);
		if (replay) return { ok: true, revision: replay };
		if (base !== this.revision)
			return { ok: false, kind: 'conflict', currentRevision: this.revision };
		this.revision += 1;
		this.page = { title: mutation.title, source: mutation.source };
		this.applied.set(mutation.mutationId, this.revision);
		if (this.mode === 'lose-response') return { ok: false, kind: 'offline' };
		return { ok: true, revision: this.revision };
	};
}

let ids = 0;
function setup(initial: ServerPage = { title: 't', source: '', revision: 1 }, draft?: Draft) {
	const clock = new FakeClock();
	const store = new MemoryStore();
	const server = new FakeServer();
	server.revision = initial.revision;
	server.page = { title: initial.title, source: initial.source };
	const auto = new Autosave(
		'p1',
		restore(initial, draft),
		{ store, transport: server, clock },
		{
			newId: () => `m${++ids}`
		}
	);
	const states: string[] = [];
	auto.subscribe((s) => states.push(s));
	return { clock, store, server, auto, states };
}

describe('Autosave', () => {
	it('saves locally after ~200ms and to the server after an 800ms pause', async () => {
		const { clock, store, server, auto, states } = setup();
		auto.edit({ title: 't', source: 'a' });
		await clock.advance(199);
		expect(store.drafts.size).toBe(0);
		await clock.advance(1);
		expect(store.drafts.get('p1')?.source).toBe('a');
		expect(auto.state).toBe('local-saved');
		await clock.advance(600);
		expect(server.calls).toHaveLength(1);
		expect(auto.state).toBe('synced');
		expect(store.drafts.size).toBe(0); // draft removed only after the server confirmed
		expect(states).toEqual(['clean', 'dirty', 'local-saved', 'sending', 'synced']);
	});

	it('sends at least every 5 s while typing continuously', async () => {
		const { clock, server, auto } = setup();
		for (let i = 0; i < 30; i++) {
			auto.edit({ title: 't', source: 'x'.repeat(i + 1) });
			await clock.advance(250);
		}
		// 7.5 s of continuous typing with 250 ms gaps: the 800 ms debounce never elapses.
		expect(server.calls.length).toBeGreaterThanOrEqual(1);
		expect(server.calls[0].mutation.source.length).toBeLessThan(30);
	});

	it('keeps one request in flight and sends edits made meanwhile in the next snapshot', async () => {
		const { clock, server, auto } = setup();
		let release!: () => void;
		server.gate = new Promise((r) => (release = r));
		auto.edit({ title: 't', source: 'first' });
		await clock.advance(800);
		expect(server.calls).toHaveLength(1);
		auto.edit({ title: 't', source: 'first second' });
		await clock.advance(5000);
		expect(server.calls).toHaveLength(1); // still in flight
		server.gate = null;
		release();
		await clock.advance(0);
		await clock.advance(10);
		expect(server.calls).toHaveLength(2);
		expect(server.calls[1]).toMatchObject({ base: 2, mutation: { source: 'first second' } });
		expect(server.page.source).toBe('first second');
		expect(auto.state).toBe('synced');
	});

	it('retries an unchanged snapshot with the same mutationId after a lost response', async () => {
		const { clock, server, auto } = setup();
		server.mode = 'lose-response';
		auto.edit({ title: 't', source: 'once' });
		await clock.advance(800);
		expect(auto.state).toBe('offline');
		server.mode = 'ok';
		auto.retry();
		await clock.advance(0);
		expect(server.calls.map((c) => c.mutation.mutationId)).toEqual(['m' + ids, 'm' + ids]);
		expect(server.revision).toBe(2); // applied once
		expect(auto.state).toBe('synced');
	});

	it('stops on auth failure, keeps the draft, and resumes after retry', async () => {
		const { clock, store, server, auto } = setup();
		server.mode = 'auth';
		auto.edit({ title: 't', source: 'secret draft' });
		await clock.advance(1000);
		expect(auto.state).toBe('auth-required');
		auto.edit({ title: 't', source: 'secret draft 2' });
		await clock.advance(6000);
		expect(server.calls).toHaveLength(1); // no automatic resend while auth is required
		expect(store.drafts.get('p1')?.source).toBe('secret draft 2');
		server.mode = 'ok';
		auto.retry();
		await clock.advance(0);
		expect(server.page.source).toBe('secret draft 2');
		expect(auto.state).toBe('synced');
	});

	it('enters conflict without overwriting and lets the user choose', async () => {
		const { clock, server, auto } = setup();
		server.revision = 2; // another device saved
		server.page = { title: 't', source: 'from other device' };
		auto.edit({ title: 't', source: 'mine' });
		await clock.advance(1000);
		expect(auto.state).toBe('conflict');
		expect(server.page.source).toBe('from other device');
		auto.edit({ title: 't', source: 'mine, more' });
		await clock.advance(6000);
		expect(server.calls).toHaveLength(1);

		await auto.resolveConflict('keep-local', { ...server.page, revision: server.revision });
		await clock.advance(0);
		expect(server.page.source).toBe('mine, more');
		expect(auto.state).toBe('synced');
	});

	it('can take the server copy and drop local edits on conflict', async () => {
		const { clock, store, server, auto } = setup();
		server.revision = 3;
		server.page = { title: 't', source: 'server' };
		auto.edit({ title: 't', source: 'local' });
		await clock.advance(1000);
		await auto.resolveConflict('take-server', { ...server.page, revision: 3 });
		expect(auto.snapshot.source).toBe('server');
		expect(auto.revision).toBe(3);
		expect(store.drafts.size).toBe(0);
		expect(auto.state).toBe('synced');
	});

	it('reports quota errors but still tries the server', async () => {
		const { clock, store, server, auto } = setup();
		store.failPut = true;
		auto.edit({ title: 't', source: 'big' });
		await clock.advance(300);
		expect(auto.state).toBe('quota-error');
		await clock.advance(1000);
		expect(server.page.source).toBe('big');
	});

	it('pauses on a rejected save (e.g. duplicate title) until the content changes', async () => {
		const { clock, server, auto } = setup();
		let reject = true;
		const original = server.save;
		server.save = async (id, base, m) =>
			reject && m.title === 'dup'
				? { ok: false, kind: 'invalid', message: 'name_conflict' }
				: original(id, base, m);
		auto.edit({ title: 'dup', source: 'x' });
		await clock.advance(1000);
		expect(auto.state).toBe('invalid');
		expect(auto.lastError).toBe('name_conflict');
		await clock.advance(10_000);
		expect(server.calls).toHaveLength(0);
		reject = false;
		auto.edit({ title: 'unique', source: 'x' });
		await clock.advance(1000);
		expect(auto.state).toBe('synced');
	});

	it('backs off on server errors and recovers automatically', async () => {
		const { clock, server, auto } = setup();
		server.mode = 'server';
		auto.edit({ title: 't', source: 'x' });
		await clock.advance(800);
		expect(auto.state).toBe('server-error');
		server.mode = 'ok';
		await clock.advance(2000);
		expect(auto.state).toBe('synced');
	});
});

describe('hold (images uploading)', () => {
	it('keeps the snapshot local while held and sends after release', async () => {
		const { clock, server, auto, store } = setup();
		let uploading = true;
		auto.setHold((snap) => uploading && snap.source.includes('[asset:'));
		auto.edit({ title: 't', source: 'text [asset:x]' });
		await clock.advance(6000);
		expect(auto.state).toBe('uploading');
		expect(server.calls).toHaveLength(0);
		expect(store.drafts.get('p1')?.source).toBe('text [asset:x]');
		uploading = false;
		auto.retry();
		await clock.advance(0);
		expect(server.page.source).toBe('text [asset:x]');
		expect(auto.state).toBe('synced');
	});

	it('removing the image marker lets the text be published', async () => {
		const { clock, server, auto } = setup();
		auto.setHold((snap) => snap.source.includes('[asset:'));
		auto.edit({ title: 't', source: 'text [asset:x]' });
		await clock.advance(1000);
		auto.edit({ title: 't', source: 'text' });
		await clock.advance(1000);
		expect(server.page.source).toBe('text');
	});
});

describe('adoptServer', () => {
	it('adopts a newer server copy only when there are no local edits', async () => {
		const { clock, auto } = setup();
		expect(auto.adoptServer({ title: 't', source: 'newer', revision: 2 })).toBe(true);
		expect(auto.snapshot.source).toBe('newer');
		expect(auto.revision).toBe(2);
		auto.edit({ title: 't', source: 'local edit' });
		await clock.advance(100);
		expect(auto.adoptServer({ title: 't', source: 'even newer', revision: 3 })).toBe(false);
		expect(auto.snapshot.source).toBe('local edit');
	});
});

describe('restore', () => {
	const server: ServerPage = { title: 't', source: 'server v2', revision: 2 };
	const draft = (d: Partial<Draft>): Draft => ({
		pageId: 'p1',
		title: 't',
		source: 'local',
		baseRevision: 2,
		savedAt: 0,
		...d
	});

	it('resumes a draft made on the current revision (reload during editing)', () => {
		const r = restore(server, draft({}));
		expect(r).toMatchObject({ current: { source: 'local' }, baseRevision: 2, restoredDraft: true });
		expect(r.conflict).toBeUndefined();
	});

	it('treats a pending mutation that the server already applied as synced', () => {
		const r = restore(
			{ title: 't', source: 'local', revision: 3 },
			draft({ baseRevision: 2, pending: { mutationId: 'm', title: 't', source: 'local' } })
		);
		expect(r).toMatchObject({ baseRevision: 3, restoredDraft: false });
	});

	it('flags a conflict for a draft based on an older revision', () => {
		const r = restore({ ...server, revision: 5 }, draft({ baseRevision: 2 }));
		expect(r.conflict).toEqual({
			local: { title: 't', source: 'local' },
			server: { ...server, revision: 5 }
		});
	});

	it('ignores a draft identical to the server copy', () => {
		expect(restore(server, draft({ source: 'server v2', baseRevision: 1 })).restoredDraft).toBe(
			false
		);
	});

	it('resumes sending a restored draft automatically', async () => {
		const { clock, server: fake, auto } = setup(server, draft({}));
		expect(auto.state).toBe('local-saved');
		await clock.advance(1000);
		expect(fake.page.source).toBe('local');
		expect(auto.state).toBe('synced');
	});
});
