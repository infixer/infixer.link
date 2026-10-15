/**
 * Autosave state machine (design §4.3).
 *
 *   clean → dirty → local-saved → sending → synced
 *   exceptions: offline, auth-required, conflict, quota-error, server-error, too-large
 *
 * - Every edit is written to the local draft store (IndexedDB) after a short debounce.
 * - The server save runs after the input pauses, or at most every `remoteMaxMs`.
 * - Only one request per page is in flight; edits made meanwhile go in the next snapshot.
 * - A retried snapshot reuses its mutationId so the server can replay it idempotently.
 * - Conflicts and auth failures stop automatic sending; nothing is overwritten silently.
 *
 * Pure module: timers, storage and transport are injected so it can be tested.
 */

export type SaveState =
	| 'clean'
	| 'dirty'
	| 'local-saved'
	| 'sending'
	| 'synced'
	| 'offline'
	| 'auth-required'
	| 'conflict'
	| 'quota-error'
	| 'server-error'
	| 'too-large'
	| 'invalid';

export interface Snapshot {
	title: string;
	source: string;
}

export interface ServerPage extends Snapshot {
	revision: number;
}

export interface PendingMutation extends Snapshot {
	mutationId: string;
}

export interface Draft extends Snapshot {
	pageId: string;
	baseRevision: number;
	pending?: PendingMutation;
	savedAt: number;
}

export interface DraftStore {
	get(pageId: string): Promise<Draft | undefined>;
	put(draft: Draft): Promise<void>;
	delete(pageId: string): Promise<void>;
}

export type SendResult =
	| { ok: true; revision: number }
	| {
			ok: false;
			kind: 'offline' | 'auth' | 'conflict' | 'too-large' | 'invalid' | 'server';
			currentRevision?: number;
			message?: string;
	  };

export interface Transport {
	save(pageId: string, baseRevision: number, mutation: PendingMutation): Promise<SendResult>;
}

export interface Clock {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface AutosaveOptions {
	localDelayMs?: number;
	remoteDelayMs?: number;
	remoteMaxMs?: number;
	retryDelaysMs?: number[];
	newId?: () => string;
}

export const STATE_LABEL: Record<SaveState, string> = {
	clean: '公開済み',
	synced: '公開済み',
	dirty: '編集中…',
	'local-saved': '端末に保存済み',
	sending: '送信中…',
	offline: 'オフライン（端末に保存済み）',
	'auth-required': 'ログインが必要です（下書きは端末に保存済み）',
	conflict: '別の版と競合しています',
	'quota-error': '端末に保存できません',
	'server-error': '送信に失敗しました（再試行します）',
	'too-large': '本文が大きすぎて送信できません',
	invalid: '保存できません'
};

const same = (a: Snapshot, b: Snapshot) => a.title === b.title && a.source === b.source;

/** States in which automatic sending is paused until the user acts. */
const BLOCKED: ReadonlySet<SaveState> = new Set([
	'auth-required',
	'conflict',
	'too-large',
	'invalid'
]);
/** Blocked states that clear as soon as the content changes (e.g. the title is fixed). */
const CLEARED_BY_EDIT: ReadonlySet<SaveState> = new Set(['too-large', 'invalid']);

export interface RestoreResult {
	current: Snapshot;
	/** The latest server copy the editor was opened with. */
	server: ServerPage;
	baseRevision: number;
	pending?: PendingMutation;
	/** Local edits exist that were made on an older server revision. */
	conflict?: { local: Snapshot; server: ServerPage };
	restoredDraft: boolean;
}

/**
 * Combines the latest server copy with a local draft when the editor opens.
 * - A pending mutation already applied on the server (lost response) is treated as synced.
 * - Draft on the current revision → resume it.
 * - Draft on an older revision with different content → conflict (never auto-overwrite).
 */
export function restore(server: ServerPage, draft: Draft | undefined): RestoreResult {
	if (!draft)
		return { current: server, server, baseRevision: server.revision, restoredDraft: false };

	let baseRevision = draft.baseRevision;
	let pending = draft.pending;
	if (pending && server.revision > baseRevision && same(pending, server)) {
		baseRevision = server.revision;
		pending = undefined;
	}
	if (same(draft, server)) {
		return { current: server, server, baseRevision: server.revision, restoredDraft: false };
	}
	const local = { title: draft.title, source: draft.source };
	if (baseRevision === server.revision) {
		return { current: local, server, baseRevision, pending, restoredDraft: true };
	}
	return {
		current: local,
		server,
		baseRevision: server.revision,
		conflict: { local, server },
		restoredDraft: true
	};
}

export class Autosave {
	state: SaveState = 'clean';
	conflictWith: ServerPage | null = null;
	lastError: string | null = null;

	private current: Snapshot;
	private synced: Snapshot;
	private baseRevision: number;
	private pending: PendingMutation | undefined;
	private dirtySince: number | null = null;
	private inFlight = false;
	private localTimer: unknown;
	private remoteTimer: unknown;
	private retryIndex = 0;
	private listeners = new Set<(state: SaveState) => void>();
	private readonly opts: Required<AutosaveOptions>;

	constructor(
		private readonly pageId: string,
		initial: RestoreResult,
		private readonly deps: { store: DraftStore; transport: Transport; clock: Clock },
		options: AutosaveOptions = {}
	) {
		this.opts = {
			localDelayMs: options.localDelayMs ?? 200,
			remoteDelayMs: options.remoteDelayMs ?? 800,
			remoteMaxMs: options.remoteMaxMs ?? 5000,
			retryDelaysMs: options.retryDelaysMs ?? [2000, 5000, 15000, 30000],
			newId: options.newId ?? (() => crypto.randomUUID())
		};
		this.current = initial.current;
		this.baseRevision = initial.baseRevision;
		this.pending = initial.pending;
		this.synced = { title: initial.server.title, source: initial.server.source };
		if (initial.conflict) {
			this.conflictWith = initial.conflict.server;
			this.state = 'conflict';
		} else if (initial.restoredDraft) {
			this.state = 'local-saved';
			this.dirtySince = deps.clock.now();
			this.scheduleRemote();
		}
	}

	get snapshot(): Snapshot {
		return this.current;
	}

	get revision(): number {
		return this.baseRevision;
	}

	subscribe(listener: (state: SaveState) => void): () => void {
		this.listeners.add(listener);
		listener(this.state);
		return () => this.listeners.delete(listener);
	}

	/** Called for every user edit. Never blocks input. */
	edit(snapshot: Snapshot) {
		this.current = snapshot;
		this.dirtySince ??= this.deps.clock.now();
		if (CLEARED_BY_EDIT.has(this.state)) this.lastError = null;
		if (
			(!BLOCKED.has(this.state) || CLEARED_BY_EDIT.has(this.state)) &&
			this.state !== 'quota-error'
		) {
			this.set('dirty');
		}
		this.scheduleLocal();
		this.scheduleRemote();
	}

	/** Writes the draft now (e.g. on visibilitychange → hidden). */
	async flushLocal(): Promise<void> {
		this.deps.clock.clearTimeout(this.localTimer);
		await this.saveLocal();
	}

	/** Manual retry, network back online, auth renewed, or page visible again. */
	retry() {
		if (this.state === 'conflict') return;
		if (BLOCKED.has(this.state) || this.state === 'offline' || this.state === 'server-error') {
			this.set(same(this.current, this.synced) ? 'synced' : 'dirty');
		}
		this.retryIndex = 0;
		void this.send();
	}

	/** Conflict resolution chosen by the user. */
	async resolveConflict(choice: 'keep-local' | 'take-server', server: ServerPage) {
		this.conflictWith = null;
		this.pending = undefined;
		this.baseRevision = server.revision;
		if (choice === 'take-server') {
			this.current = { title: server.title, source: server.source };
			this.synced = this.current;
			this.dirtySince = null;
			await this.deps.store.delete(this.pageId);
			this.set('synced');
			return;
		}
		this.synced = { title: server.title, source: server.source };
		this.set('dirty');
		await this.saveLocal();
		await this.send();
	}

	/**
	 * Adopts a newer server copy fetched after the editor opened (it starts from the
	 * server-rendered page). Only when nothing local is unsaved; otherwise the next
	 * save reports a conflict as usual. Returns true when the copy was adopted.
	 */
	adoptServer(server: ServerPage): boolean {
		if (server.revision <= this.baseRevision) return false;
		if (!same(this.current, this.synced) || this.pending || this.inFlight) return false;
		this.current = { title: server.title, source: server.source };
		this.synced = this.current;
		this.baseRevision = server.revision;
		return true;
	}

	dispose() {
		this.deps.clock.clearTimeout(this.localTimer);
		this.deps.clock.clearTimeout(this.remoteTimer);
		this.listeners.clear();
	}

	private set(state: SaveState) {
		if (this.state === state) return;
		this.state = state;
		for (const l of this.listeners) l(state);
	}

	private scheduleLocal() {
		this.deps.clock.clearTimeout(this.localTimer);
		this.localTimer = this.deps.clock.setTimeout(
			() => void this.saveLocal(),
			this.opts.localDelayMs
		);
	}

	private scheduleRemote(delay?: number) {
		this.deps.clock.clearTimeout(this.remoteTimer);
		const since = this.dirtySince ?? this.deps.clock.now();
		const untilMax = Math.max(0, since + this.opts.remoteMaxMs - this.deps.clock.now());
		const ms = delay ?? Math.min(this.opts.remoteDelayMs, untilMax);
		this.remoteTimer = this.deps.clock.setTimeout(() => void this.send(), ms);
	}

	private async saveLocal() {
		const draft: Draft = {
			pageId: this.pageId,
			title: this.current.title,
			source: this.current.source,
			baseRevision: this.baseRevision,
			pending: this.pending,
			savedAt: this.deps.clock.now()
		};
		try {
			await this.deps.store.put(draft);
			if (this.state === 'quota-error') this.set('dirty');
			if (this.state === 'dirty') this.set('local-saved');
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			this.set('quota-error');
		}
	}

	private async send(): Promise<void> {
		// Edits made while a request is in flight are picked up when it completes.
		if (this.inFlight) return;
		if (BLOCKED.has(this.state)) return;
		const snapshot = this.current;
		if (same(snapshot, this.synced) && !this.pending) {
			this.dirtySince = null;
			if (this.state !== 'quota-error') this.set('synced');
			return;
		}

		// Reuse the mutationId only when retrying the identical snapshot.
		const mutation: PendingMutation =
			this.pending && same(this.pending, snapshot)
				? this.pending
				: { ...snapshot, mutationId: this.opts.newId() };
		this.pending = mutation;
		this.inFlight = true;
		this.set('sending');
		await this.saveLocal(); // persist the pending mutationId before sending
		if (this.state === 'local-saved') this.set('sending');

		let result: SendResult;
		try {
			result = await this.deps.transport.save(this.pageId, this.baseRevision, mutation);
		} catch {
			result = { ok: false, kind: 'offline' };
		}
		this.inFlight = false;

		if (result.ok) {
			this.retryIndex = 0;
			this.baseRevision = result.revision;
			this.synced = { title: mutation.title, source: mutation.source };
			this.pending = undefined;
			if (same(this.current, this.synced)) {
				this.dirtySince = null;
				try {
					await this.deps.store.delete(this.pageId);
				} catch {
					// A stale draft is harmless: restore() treats it as already synced.
				}
				this.set('synced');
			} else {
				this.set('dirty');
				await this.saveLocal();
				this.scheduleRemote(0);
			}
			return;
		}

		switch (result.kind) {
			case 'conflict':
				this.pending = undefined;
				this.conflictWith = null;
				this.set('conflict');
				await this.saveLocal();
				return;
			case 'auth':
				this.set('auth-required');
				return;
			case 'too-large':
			case 'invalid':
				this.lastError = result.message ?? null;
				this.set(result.kind);
				return;
			case 'offline':
			case 'server': {
				this.set(result.kind === 'offline' ? 'offline' : 'server-error');
				const delays = this.opts.retryDelaysMs;
				const delay = delays[Math.min(this.retryIndex++, delays.length - 1)];
				this.scheduleRemote(delay);
				return;
			}
		}
	}
}
