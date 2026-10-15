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
		LinkPreviewDto,
		OwnerPageDto,
		PageRefDto,
		TitleSuggestionDto
	} from '@infixer-link/contracts';
	import { livePreview, type LiveData } from './live.ts';
	import { Autosave, STATE_LABEL, restore, type SaveState, type ServerPage } from './autosave.ts';
	import { idbDraftStore } from './draft-store.ts';
	import { httpTransport, type CsrfSource } from './transport.ts';

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
		onready: () => void;
		ondeleted: (revision: number) => void;
	}

	let {
		pageId,
		csrf,
		initial,
		focus = null,
		names,
		previews,
		onready,
		ondeleted
	}: Props = $props();

	async function postJson<T>(path: string, body: unknown): Promise<T | null> {
		const send = (token: string) =>
			fetch(path, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-csrf-token': token },
				credentials: 'same-origin',
				body: JSON.stringify(body)
			});
		let res = await send(csrf.get());
		if (res.status === 403) {
			const token = await csrf.refresh();
			if (token) res = await send(token);
		}
		return res.ok ? ((await res.json()) as T) : null;
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
	let announce = $state('');

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

		view = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: start.current.source,
				extensions: [
					history(),
					drawSelection(),
					EditorView.lineWrapping,
					livePreview({ data: { names, previews }, navigate, fetchMissing, suggest }),
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
			if (state === 'conflict') {
				const fresh = start.conflict?.server ?? (await fetchLatest());
				if (fresh) {
					conflictServer = { title: fresh.title, source: fresh.source, revision: fresh.revision };
				}
			}
		});

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
		void auto?.flushLocal();
		auto?.dispose();
		view?.destroy();
	});

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

	async function keepLocal() {
		if (!auto || !conflictServer) return;
		const server = conflictServer;
		conflictServer = null;
		await auto.resolveConflict('keep-local', server);
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

	async function remove() {
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

<svelte:window ononline={() => auto?.retry()} />
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
		<button type="button" class="link" onclick={remove}>削除</button>
	</p>

	{#if notice}<p class="notice" role="status">{notice}</p>{/if}

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
		<section class="conflict" data-testid="conflict">
			<p>別の端末などで、このページが先に更新されていました。どちらを残すか選んでください。</p>
			<div class="panes">
				<div>
					<h3>この端末の内容</h3>
					<pre>{`${auto.snapshot.title}\n\n${auto.snapshot.source}`}</pre>
				</div>
				<div>
					<h3>サーバーの最新版（版 {conflictServer.revision}）</h3>
					<pre>{`${conflictServer.title}\n\n${conflictServer.source}`}</pre>
				</div>
			</div>
			<button type="button" onclick={keepLocal}>この端末の内容で上書き</button>
			<button type="button" onclick={takeServer}
				>サーバーの版を使う（この端末の内容はファイルに保存）</button
			>
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

	.conflict {
		margin-bottom: var(--space-3);
	}

	.conflict .panes {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		gap: var(--space-2);
	}

	.conflict pre {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		max-height: 40dvh;
		overflow: auto;
		padding: var(--space-2);
		border: 1px solid var(--color-border);
		font-family: var(--font-body);
	}

	.conflict button {
		min-height: 44px;
		padding: 0 var(--space-3);
		font: inherit;
	}

	h3 {
		font-size: 0.9375rem;
		margin: 0;
	}

	.body :global(.cm-content) {
		font-family: var(--font-body);
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
