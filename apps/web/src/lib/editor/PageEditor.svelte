<!--
	Owner editor on the same page URL (design §4.2, §9.1). It is mounted as soon as the
	session probe says "owner", starts from the server-rendered content and is styled
	exactly like the read view, so the page can switch to it without a visible change.
	There is no edit mode and no "done" step: clicks land in the text and autosave runs.
-->
<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { Annotation, EditorSelection, EditorState } from '@codemirror/state';
	import { EditorView, keymap, drawSelection } from '@codemirror/view';
	import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
	import type {
		AssetDto,
		LinkPreviewDto,
		OwnerPageDto,
		PageRefDto,
		TitleSuggestionDto
	} from '@infixer-link/contracts';
	import { livePreview, type LiveData, type LivePreview } from './live.ts';
	import { Uploads } from './uploads.svelte.ts';
	import {
		Autosave,
		STATE_LABEL,
		restore,
		type SaveState,
		type ServerPage,
		type Snapshot
	} from './autosave.ts';
	import { idbDraftStore } from './draft-store.ts';
	import { httpTransport, type CsrfSource } from './transport.ts';
	import ConflictResolver from './ConflictResolver.svelte';
	import { deleteStoredUpload, storedUploads } from './uploads.svelte.ts';
	import { acquirePageLock } from '../offline/locks.ts';
	import { registerFlush } from '../offline/flush.ts';
	import { localDb } from './local-db.ts';

	interface Props {
		pageId: string;
		csrf: CsrfSource;
		/** Server-rendered copy; the editor starts from it and refreshes in the background. */
		initial: ServerPage & { updatedAt: string };
		/** Where to put the cursor right away (new or just-created pages). */
		focus?: 'title' | 'body' | null;
		/** Link names and card previews resolved on the server for the initial content. */
		names: Record<string, PageRefDto>;
		previews: Record<string, LinkPreviewDto>;
		assets: Record<string, AssetDto>;
		onready: () => void;
		ondeleted: (revision: number) => void;
		/** A page created on this device was saved on the server for the first time. */
		oncreated?: (pageId: string) => void;
	}

	let {
		pageId,
		csrf,
		initial,
		focus = null,
		names,
		previews,
		assets,
		onready,
		ondeleted,
		oncreated
	}: Props = $props();

	async function postJson<T>(path: string, body: unknown): Promise<T | null> {
		const send = (token: string) =>
			fetch(path, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-csrf-token': token },
				credentials: 'same-origin',
				body: JSON.stringify(body)
			});
		try {
			let res = await send(csrf.get());
			if (res.status === 403) {
				const token = await csrf.refresh();
				if (token) res = await send(token);
			}
			return res.ok ? ((await res.json()) as T) : null;
		} catch {
			return null; // offline: names and cards are looked up again later
		}
	}

	async function fetchMissing(missing: {
		names: string[];
		urls: string[];
	}): Promise<Partial<LiveData>> {
		const [resolved, cards] = await Promise.all([
			missing.names.length
				? postJson<{ pages: Record<string, PageRefDto> }>('/api/owner/v1/names/resolve', {
						names: missing.names
					})
				: null,
			missing.urls.length
				? postJson<{ previews: Record<string, LinkPreviewDto> }>('/api/owner/v1/link-previews', {
						urls: missing.urls.slice(0, 20)
					})
				: null
		]);
		return { names: resolved?.pages, previews: cards?.previews };
	}

	async function suggest(query: string, signal: AbortSignal): Promise<TitleSuggestionDto[]> {
		const res = await fetch(`/api/owner/v1/titles?q=${encodeURIComponent(query)}&limit=12`, {
			credentials: 'same-origin',
			signal
		});
		return res.ok ? ((await res.json()) as { titles: TitleSuggestionDto[] }).titles : [];
	}

	async function navigate(href: string, external: boolean) {
		if (external) {
			window.open(href, '_blank', 'noopener');
			return;
		}
		await auto?.flushLocal();
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- internal /p/ or /t/ path
		await goto(href);
	}

	/** Marks programmatic document replacements so they are not treated as user edits. */
	const external = Annotation.define<boolean>();

	let host: HTMLDivElement;
	let titleInput = $state<HTMLInputElement>();
	let view: EditorView | undefined;
	let auto = $state<Autosave>();
	let saveState = $state<SaveState>('clean');
	let title = $state('');
	let updatedAt = $state('');
	let notice = $state('');
	let conflictServer = $state<ServerPage | null>(null);
	/** Common base of the conflict, when known. */
	let conflictBase = $state<Snapshot | undefined>(undefined);
	/** Created on this device, but another device created the day's page first. */
	let existingPageId = $state<string | null>(null);
	let announce = $state('');
	let releaseLock: (() => void) | undefined;
	let unregisterFlush: (() => void) | undefined;

	const clock = {
		now: () => Date.now(),
		setTimeout: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
		clearTimeout: (h: unknown) => window.clearTimeout(h as number)
	};

	async function fetchLatest(): Promise<OwnerPageDto | null> {
		try {
			const res = await fetch(`/api/owner/v1/pages/${pageId}`, {
				credentials: 'same-origin',
				cache: 'no-store'
			});
			return res.ok ? ((await res.json()) as OwnerPageDto) : null;
		} catch {
			return null;
		}
	}

	function edited() {
		auto?.edit({ title, source: view?.state.doc.toString() ?? '' });
	}

	function replaceDoc(source: string) {
		if (!view || view.state.doc.toString() === source) return;
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: source },
			annotations: external.of(true)
		});
	}

	onMount(async () => {
		// One sender per page: the background outbox sync skips pages open here, and a run
		// already sending this page finishes before the draft is read (ADR 0015).
		releaseLock = await acquirePageLock(pageId);
		const server: ServerPage = {
			title: initial.title,
			source: initial.source,
			revision: initial.revision
		};
		const draft = await idbDraftStore.get(pageId).catch(() => undefined);
		const start = restore(server, draft);
		title = start.current.title;
		updatedAt = initial.updatedAt;
		if (start.restoredDraft && !start.conflict)
			notice = '端末に保存されていた下書きを復元しました。';

		live = livePreview({
			data: { names, previews, assets },
			navigate,
			fetchMissing,
			suggest,
			localImage: (id) => uploads.preview(id)
		});

		view = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: start.current.source,
				extensions: [
					history(),
					drawSelection(),
					EditorView.lineWrapping,
					live.extension,
					EditorView.domEventHandlers({
						paste: (event, v) =>
							takeImages(event.clipboardData?.files, event) || pasteUrlAsCard(v, event),
						drop: (event, v) => {
							const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
							if (pos !== null) v.dispatch({ selection: EditorSelection.cursor(pos) });
							return takeImages(event.dataTransfer?.files, event);
						}
					}),
					keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
					EditorView.contentAttributes.of({ 'aria-label': '本文', spellcheck: 'false' }),
					EditorView.cspNonce.of(
						document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? ''
					),
					// Match the read view (.line: white-space pre-wrap, same font and line height).
					EditorView.theme({
						'&': { fontSize: '1rem', color: 'inherit', backgroundColor: 'transparent' },
						'&.cm-focused': { outline: 'none' },
						'.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit', overflow: 'visible' },
						'.cm-content': { padding: '0', caretColor: 'currentColor', minHeight: '6rem' },
						'.cm-line': { padding: '0' },
						// Visible caret / selection in both themes (CodeMirror's default caret is black).
						'.cm-cursor, .cm-dropCursor': {
							borderLeftColor: 'var(--color-caret)',
							borderLeftWidth: '2px'
						},
						'&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
							{ background: 'var(--color-selection)' }
					}),
					EditorView.updateListener.of((update) => {
						if (!update.docChanged) return;
						if (update.transactions.some((t) => t.annotation(external))) return;
						edited();
					})
				]
			})
		});

		auto = new Autosave(pageId, start, {
			store: idbDraftStore,
			transport: httpTransport(csrf),
			clock
		});
		unregisterFlush = registerFlush(() => auto?.flushLocal() ?? Promise.resolve());
		let firstConflict = true;
		let wasLocalOnly = auto.localOnly;
		// Pages referencing images that are still uploading stay local (design §10.2).
		auto.setHold((snapshot) => uploads.isPending(snapshot.source));
		void uploads.resume(start.current.source);
		auto.subscribe(async (state) => {
			saveState = state;
			if (state === 'synced') updatedAt = new Date().toISOString();
			// Announce outcomes only, never every keystroke (design §14.3).
			if (
				[
					'synced',
					'offline',
					'auth-required',
					'conflict',
					'quota-error',
					'too-large',
					'invalid'
				].includes(state)
			) {
				announce = STATE_LABEL[state];
			}
			if (wasLocalOnly && auto && !auto.localOnly) {
				wasLocalOnly = false;
				oncreated?.(pageId);
			}
			if (state === 'conflict' && auto) {
				if (auto.conflictInfo.existingPageId) {
					existingPageId = auto.conflictInfo.existingPageId;
					return;
				}
				// Restored conflicts carry the draft's base; later ones use the last synced copy.
				const base = firstConflict && start.conflict ? start.conflict.base : auto.base;
				const fresh = (firstConflict && start.conflict?.server) || (await fetchLatest());
				firstConflict = false;
				if (fresh) {
					conflictBase = base;
					conflictServer = { title: fresh.title, source: fresh.source, revision: fresh.revision };
				}
			}
		});
		void checkStorage();

		onready();
		await tick(); // the parent un-hides this layer; hidden elements cannot take focus
		if (focus === 'title') {
			titleInput?.focus();
			titleInput?.select();
		} else if (focus === 'body') {
			view.focus();
			view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
		}

		// The SSR copy may be stale (e.g. edited on another device moments ago).
		const latest = await fetchLatest();
		if (!latest || !auto) return;
		if (latest.deletedAt) return ondeleted(latest.revision);
		if (
			auto.adoptServer({ title: latest.title, source: latest.source, revision: latest.revision })
		) {
			title = latest.title;
			updatedAt = latest.updatedAt;
			replaceDoc(latest.source);
		}
	});

	function onVisibility() {
		if (!auto) return;
		if (document.visibilityState === 'hidden') void auto.flushLocal();
		else if (['offline', 'server-error'].includes(auto.state)) auto.retry();
	}

	onDestroy(() => {
		void auto?.flushLocal().finally(() => releaseLock?.());
		unregisterFlush?.();
		auto?.dispose();
		uploads.dispose();
		view?.destroy();
	});

	// --- images -------------------------------------------------------------

	let live: LivePreview | undefined;
	let fileInput = $state<HTMLInputElement>();
	let exifNoticeShown = false;

	// The editor is re-created per page ({#key} in the page), so the initial values are right.
	// svelte-ignore state_referenced_locally
	const uploads = new Uploads(
		pageId,
		csrf,
		(asset) => {
			if (view) live?.refresh(view, { assets: { [asset.id]: asset } });
			auto?.retry();
		},
		() => {
			if (view) live?.refresh(view);
			auto?.retry();
		}
	);

	let failedUploads = $derived(
		Object.entries(uploads.states).filter(([, s]) => s.status === 'failed')
	);

	/** Inserts `[asset:id]` lines for the images at the cursor and starts uploading them. */
	function insertImages(files: File[]) {
		if (!view || files.length === 0) return;
		const problems = files.map((f) => Uploads.check(f)).filter(Boolean);
		const ok = files.filter((f) => !Uploads.check(f));
		if (problems.length) notice = problems[0]!;
		if (ok.length === 0) return;
		const markers = ok.map((f) => `[asset:${uploads.add(f, f.name)}]`);
		const { state } = view;
		const pos = state.selection.main.head;
		const line = state.doc.lineAt(pos);
		const before = line.text.slice(0, pos - line.from).trim() ? '\n' : '';
		const after = line.text.slice(pos - line.from).trim() ? '\n' : '';
		const insert = `${before}${markers.join('\n')}${after}`;
		view.dispatch({
			changes: { from: pos, insert },
			selection: EditorSelection.cursor(pos + insert.length),
			userEvent: 'input.paste'
		});
		view.focus();
		// Inserting an image is a milestone: persist the draft now, not after the debounce.
		void auto?.flushLocal();
		if (!exifNoticeShown) {
			exifNoticeShown = true;
			notice = '画像は原本のまま公開されます（撮影位置などの情報を含む場合があります）。';
		}
	}

	function takeImages(files: FileList | undefined, event: Event): boolean {
		const images = [...(files ?? [])].filter((f) => f.type.startsWith('image/'));
		if (images.length === 0) return false;
		event.preventDefault();
		insertImages(images);
		return true;
	}

	/**
	 * A pasted URL on its own becomes a link card (ADR 0010): it gets its own line and the
	 * cursor moves to the next line, so the card renders right away. Inside link syntax
	 * (`[label](` or `[`) the URL is pasted as plain text.
	 */
	function pasteUrlAsCard(v: EditorView, event: ClipboardEvent): boolean {
		const text = event.clipboardData?.getData('text/plain').trim() ?? '';
		if (!/^https?:\/\/\S+$/i.test(text) || text.length > 2048) return false;
		const { state } = v;
		const range = state.selection.main;
		const line = state.doc.lineAt(range.from);
		const before = line.text.slice(0, range.from - line.from);
		if (/[[(]\s*$/.test(before) || /\[[^\]]*$/.test(before)) return false;
		event.preventDefault();
		const lead = before.trim() ? '\n' : '';
		const indent = before.trim() ? (/^[ \t\u3000]*/.exec(line.text)?.[0] ?? '') : '';
		// Always end with a line break so the cursor leaves the URL line and the card shows.
		const insert = `${lead}${indent}${text}\n`;
		v.dispatch({
			changes: { from: range.from, to: range.to, insert },
			selection: EditorSelection.cursor(range.from + insert.length),
			scrollIntoView: true,
			userEvent: 'input.paste'
		});
		return true;
	}

	function pickImages() {
		fileInput?.click();
	}

	function picked(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		insertImages([...(input.files ?? [])]);
		input.value = '';
	}

	function removeFailed(assetId: string) {
		if (!view) return;
		const doc = view.state.doc;
		const at = doc.toString().indexOf(`[asset:${assetId}]`);
		if (at === -1) return;
		const line = doc.lineAt(at);
		const marker = `[asset:${assetId}]`;
		// An image on its own line is removed with its line break; inline ones just vanish.
		const change =
			line.text.trim() === marker
				? line.number > 1
					? { from: line.from - 1, to: line.to }
					: { from: line.from, to: Math.min(line.to + 1, doc.length) }
				: { from: at, to: at + marker.length };
		view.dispatch({ changes: change, userEvent: 'delete' });
	}

	function downloadLocal() {
		if (!auto) return;
		const blob = new Blob([`${auto.snapshot.title}\n\n${auto.snapshot.source}`], {
			type: 'text/plain;charset=utf-8'
		});
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `${pageId}.draft.link.txt`;
		a.click();
		URL.revokeObjectURL(a.href);
	}

	async function saveResolved(snapshot: Snapshot) {
		if (!auto || !conflictServer) return;
		const server = conflictServer;
		conflictServer = null;
		title = snapshot.title;
		replaceDoc(snapshot.source);
		await auto.resolveConflict({ use: snapshot }, server);
	}

	async function takeServer() {
		if (!auto || !conflictServer) return;
		downloadLocal();
		const server = conflictServer;
		conflictServer = null;
		await auto.resolveConflict('take-server', server);
		title = server.title;
		replaceDoc(server.source);
	}

	/**
	 * The day's page was created on another device while this one was offline: add this
	 * device's text to the end of that page (as an ordinary edit, still saved by autosave).
	 */
	async function appendToExisting() {
		if (!auto || !existingPageId) return;
		const res = await fetch(`/api/owner/v1/pages/${existingPageId}`, {
			credentials: 'same-origin',
			cache: 'no-store'
		}).catch(() => null);
		if (!res?.ok) {
			notice = 'サーバーの日記を取得できませんでした。接続を確認してください。';
			return;
		}
		const existing = (await res.json()) as OwnerPageDto;
		const mine = auto.snapshot.source.trim();
		const source = existing.source.trimEnd() ? `${existing.source.trimEnd()}\n${mine}` : mine;
		await idbDraftStore.put({
			pageId: existing.id,
			title: existing.title,
			source,
			baseRevision: existing.revision,
			base: { title: existing.title, source: existing.source },
			savedAt: Date.now()
		});
		// Images waiting to be uploaded move with the text.
		const db = await localDb();
		for (const upload of await storedUploads(pageId)) {
			await db.put('uploads', { ...upload, pageId: existing.id });
		}
		await idbDraftStore.delete(pageId);
		location.assign(`/p/${existing.id}/${encodeURIComponent(existing.title)}`);
	}

	async function discardLocalOnly() {
		if (!confirm('この端末だけにあるページを削除しますか？（ダウンロードしてから削除します）'))
			return;
		downloadLocal();
		for (const upload of await storedUploads(pageId).catch(() => [])) {
			await deleteStoredUpload(upload.assetId);
		}
		await idbDraftStore.delete(pageId);
		ondeleted(0);
	}

	/** Asks the browser to keep this site's storage, and warns when it is almost full. */
	async function checkStorage() {
		try {
			await navigator.storage?.persist?.();
			const estimate = await navigator.storage?.estimate?.();
			if (estimate?.quota && estimate.usage && estimate.usage / estimate.quota > 0.9) {
				notice = `端末の保存領域が残りわずかです（${Math.round((estimate.usage / estimate.quota) * 100)}% 使用中）。未送信の下書きはダウンロードできます。`;
			}
		} catch {
			// not supported
		}
	}

	async function remove() {
		if (auto?.localOnly) return discardLocalOnly();
		if (!auto || !confirm('このページを削除しますか？ 履歴は残り、あとから元に戻せます。')) return;
		await auto.flushLocal();
		const send = (token: string) =>
			fetch(`/api/owner/v1/pages/${pageId}`, {
				method: 'DELETE',
				headers: { 'content-type': 'application/json', 'x-csrf-token': token },
				credentials: 'same-origin',
				body: JSON.stringify({ baseRevision: auto!.revision, mutationId: crypto.randomUUID() })
			});
		let res = await send(csrf.get());
		if (res.status === 403) {
			const token = await csrf.refresh();
			if (token) res = await send(token);
		}
		if (!res.ok) {
			notice =
				res.status === 409
					? '保存中の変更があるため削除できませんでした。少し待ってからもう一度お試しください。'
					: '削除できませんでした。';
			return;
		}
		const body = (await res.json()) as { revision: number };
		await idbDraftStore.delete(pageId).catch(() => {});
		ondeleted(body.revision);
	}

	const loginHref = () => resolve(`/owner/login?returnTo=${encodeURIComponent(location.pathname)}`);
</script>

<svelte:window ononline={() => auto?.retry()} onpagehide={() => void auto?.flushLocal()} />
<svelte:document onvisibilitychange={onVisibility} />

<div class="editor" data-testid="editor">
	<input
		class="title"
		bind:this={titleInput}
		bind:value={title}
		oninput={edited}
		aria-label="タイトル"
		maxlength="200"
	/>
	<p class="meta">
		更新 <time datetime={updatedAt}>{updatedAt.slice(0, 10)}</time>
		<span class="status" data-state={saveState} data-testid="save-state"
			>{saveState === 'clean' ? '' : STATE_LABEL[saveState]}</span
		>
		{#if auto?.localOnly}<span class="local-only" data-testid="local-only"
				>この端末だけに保存（未公開）</span
			>{/if}
		<button type="button" class="link" onclick={pickImages} data-testid="add-image">画像</button>
		<button type="button" class="link" onclick={remove}>削除</button>
		<input
			class="file"
			type="file"
			accept="image/jpeg,image/png,image/gif,image/webp"
			multiple
			bind:this={fileInput}
			onchange={picked}
			data-testid="image-input"
		/>
	</p>

	{#if notice}<p class="notice" role="status">{notice}</p>{/if}

	{#each failedUploads as [id, upload] (id)}
		<p class="notice" role="alert">
			画像を送信できませんでした：{upload.error}
			{#if upload.retryable}
				<button type="button" class="link" onclick={() => uploads.retry(id)}>再送信</button>
			{/if}
			<button type="button" class="link" onclick={() => removeFailed(id)}>画像を外す</button>
		</p>
	{/each}

	{#if saveState === 'auth-required'}
		<p class="notice">
			ログインの有効期限が切れました。下書きはこの端末に保存されています。
			<a href={loginHref()} target="_blank" rel="noopener">別タブでログイン</a>
			してから <button type="button" class="link" onclick={() => auto?.retry()}>再送信</button>
		</p>
	{:else if saveState === 'offline' || saveState === 'server-error'}
		<p class="notice">
			接続が回復すると自動で送信します。<button
				type="button"
				class="link"
				onclick={() => auto?.retry()}>今すぐ再送信</button
			>
		</p>
	{:else if saveState === 'invalid' || saveState === 'too-large'}
		<p class="notice">{auto?.lastError ?? ''}（内容を修正すると再送信します）</p>
	{:else if saveState === 'quota-error'}
		<p class="notice">
			端末の保存領域が不足しています。<button type="button" class="link" onclick={downloadLocal}
				>下書きをダウンロード</button
			>
		</p>
	{/if}

	{#if conflictServer && auto}
		<ConflictResolver
			base={conflictBase}
			local={auto.snapshot}
			server={conflictServer}
			onsave={saveResolved}
			ontakeserver={takeServer}
		/>
	{/if}

	{#if existingPageId}
		<section class="collision" data-testid="daily-collision">
			<p>
				この日の日記は、別の端末で先に作成されていました。この端末で書いた内容は消えていません。
			</p>
			<button type="button" onclick={appendToExisting} data-testid="append-to-existing"
				>サーバーの日記の末尾に追加して開く</button
			>
			<button type="button" onclick={downloadLocal}>この端末の内容をダウンロード</button>
		</section>
	{/if}

	<div class="body" bind:this={host}></div>
	<p class="sr-only" aria-live="polite">{announce}</p>
</div>

<style>
	/* Mirrors the read view in routes/p/[id]/[[slug]]/+page.svelte (h1 / .meta / .line). */
	.title {
		display: block;
		width: 100%;
		margin: 0;
		padding: 0;
		border: none;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 1.5rem;
		font-weight: 700;
		line-height: inherit;
	}

	.title:focus {
		outline: none;
	}

	.meta {
		margin: var(--space-1) 0 var(--space-3);
		color: var(--color-muted);
		font-size: 0.875rem;
	}

	.status:not(:empty)::before {
		content: '・';
	}

	.status[data-state='conflict'],
	.status[data-state='auth-required'],
	.status[data-state='quota-error'],
	.status[data-state='invalid'],
	.status[data-state='too-large'] {
		color: var(--color-danger);
	}

	.link {
		/* Larger touch target without changing the line height of the meta row. */
		margin: -0.75rem 0 -0.75rem var(--space-1);
		padding: 0.75rem var(--space-2);
		border: none;
		background: none;
		color: var(--color-muted);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}

	.notice {
		margin: 0 0 var(--space-2);
		padding: var(--space-2);
		border: 1px solid var(--color-border);
		overflow-wrap: anywhere;
	}

	.collision {
		margin-bottom: var(--space-3);
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--color-danger);
		border-radius: 0.5rem;
	}

	.collision button {
		min-height: 44px;
		padding: 0 var(--space-3);
		font: inherit;
	}

	.local-only::before {
		content: '・';
	}

	.body :global(.cm-content) {
		font-family: var(--font-body);
	}

	.file {
		display: none;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
