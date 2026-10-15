<!--
	Owner editor, loaded lazily on the same page URL after the session check (design §4.2, §9.1).
	CodeMirror owns selection, IME composition and undo; we only observe document changes.
-->
<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { EditorState } from '@codemirror/state';
	import { EditorView, keymap, drawSelection } from '@codemirror/view';
	import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
	import type { OwnerPageDto } from '@infixer-link/contracts';
	import { Autosave, STATE_LABEL, restore, type SaveState, type ServerPage } from './autosave.ts';
	import { idbDraftStore } from './draft-store.ts';
	import { httpTransport, type CsrfSource } from './transport.ts';

	interface Props {
		pageId: string;
		csrf: CsrfSource;
		onclose: (page: { title: string; source: string; revision: number }) => void;
		ondeleted: (revision: number) => void;
	}

	let { pageId, csrf, onclose, ondeleted }: Props = $props();

	let host: HTMLDivElement;
	let titleInput = $state<HTMLInputElement>();
	let view: EditorView | undefined;
	let auto = $state<Autosave>();
	let saveState = $state<SaveState>('clean');
	let title = $state('');
	let loading = $state(true);
	let fatal = $state('');
	let notice = $state('');
	let conflictServer = $state<ServerPage | null>(null);
	let announce = $state('');

	const clock = {
		now: () => Date.now(),
		setTimeout: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
		clearTimeout: (h: unknown) => window.clearTimeout(h as number)
	};

	async function fetchLatest(): Promise<OwnerPageDto | null> {
		const res = await fetch(`/api/owner/v1/pages/${pageId}`, {
			credentials: 'same-origin',
			cache: 'no-store'
		});
		if (res.status === 401) {
			fatal = 'ログインが切れています。もう一度ログインしてください。';
			return null;
		}
		if (!res.ok) {
			fatal = 'ページを読み込めませんでした。';
			return null;
		}
		return (await res.json()) as OwnerPageDto;
	}

	function edited() {
		auto?.edit({ title, source: view?.state.doc.toString() ?? '' });
	}

	function setDoc(source: string) {
		view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } });
	}

	onMount(async () => {
		const latest = await fetchLatest();
		if (!latest) return (loading = false);
		if (latest.deletedAt) {
			fatal = 'このページは削除されています。';
			return (loading = false);
		}
		const server: ServerPage = {
			title: latest.title,
			source: latest.source,
			revision: latest.revision
		};
		const draft = await idbDraftStore.get(pageId).catch(() => undefined);
		const initial = restore(server, draft);
		title = initial.current.title;
		if (initial.restoredDraft && !initial.conflict)
			notice = '端末に保存されていた下書きを復元しました。';

		view = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: initial.current.source,
				extensions: [
					history(),
					drawSelection(),
					EditorView.lineWrapping,
					keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
					EditorView.contentAttributes.of({ 'aria-label': '本文', spellcheck: 'false' }),
					EditorView.cspNonce.of(
						document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? ''
					),
					EditorView.updateListener.of((update) => {
						if (update.docChanged) edited();
					})
				]
			})
		});

		auto = new Autosave(pageId, initial, {
			store: idbDraftStore,
			transport: httpTransport(csrf),
			clock
		});
		auto.subscribe(async (state) => {
			saveState = state;
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
				const fresh = initial.conflict?.server ?? (await fetchLatest());
				if (fresh)
					conflictServer = { title: fresh.title, source: fresh.source, revision: fresh.revision };
			}
		});
		loading = false;
		view.focus();
	});

	function onVisibility() {
		if (!auto) return;
		if (document.visibilityState === 'hidden') void auto.flushLocal();
		else if (['offline', 'server-error'].includes(auto.state)) auto.retry();
	}

	function onOnline() {
		auto?.retry();
	}

	onDestroy(() => {
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
		setDoc(server.source);
	}

	async function done() {
		if (!auto) return onclose({ title, source: '', revision: 0 });
		await auto.flushLocal();
		if (auto.state !== 'synced' && auto.state !== 'clean') {
			auto.retry();
			for (let i = 0; i < 50 && auto.state === 'sending'; i++)
				await new Promise((r) => setTimeout(r, 100));
		}
		if (auto.state === 'synced' || auto.state === 'clean') {
			onclose({ ...auto.snapshot, revision: auto.revision });
		} else {
			notice = '未送信の変更があります。端末には保存されているので、接続が戻ると送信されます。';
		}
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
					? '別の版があるため削除できませんでした。保存を完了してから再度お試しください。'
					: '削除できませんでした。';
			return;
		}
		const body = (await res.json()) as { revision: number };
		await idbDraftStore.delete(pageId).catch(() => {});
		ondeleted(body.revision);
	}
</script>

<svelte:window ononline={onOnline} />
<svelte:document onvisibilitychange={onVisibility} />

<div class="editor" data-testid="editor">
	{#if fatal}
		<p class="error" role="alert">{fatal}</p>
		{#if fatal.includes('ログイン')}
			<a href={resolve(`/owner/login?returnTo=${encodeURIComponent(location.pathname)}`)}
				>ログイン</a
			>
		{/if}
	{/if}

	<div class="bar">
		<span class="status" data-state={saveState} data-testid="save-state"
			>{STATE_LABEL[saveState]}</span
		>
		<span class="actions">
			<button type="button" onclick={remove} disabled={loading || !!fatal}>削除</button>
			<button type="button" class="primary" onclick={done} disabled={loading}>完了</button>
		</span>
	</div>

	{#if notice}<p class="notice" role="status">{notice}</p>{/if}

	{#if saveState === 'auth-required'}
		<p class="notice">
			ログインの有効期限が切れました。下書きはこの端末に保存されています。
			<a
				href={resolve(`/owner/login?returnTo=${encodeURIComponent(location.pathname)}`)}
				target="_blank"
				rel="noopener">別タブでログイン</a
			>
			してから <button type="button" onclick={() => auto?.retry()}>再送信</button>
		</p>
	{:else if saveState === 'offline' || saveState === 'server-error'}
		<p class="notice">
			接続が回復すると自動で送信します。<button type="button" onclick={() => auto?.retry()}
				>今すぐ再送信</button
			>
		</p>
	{:else if saveState === 'invalid' || saveState === 'too-large'}
		<p class="notice">{auto?.lastError ?? ''}（内容を修正すると再送信します）</p>
	{:else if saveState === 'quota-error'}
		<p class="notice">
			端末の保存領域が不足しています。<button type="button" onclick={downloadLocal}
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

	<input
		class="title"
		bind:this={titleInput}
		bind:value={title}
		oninput={edited}
		aria-label="タイトル"
		maxlength="200"
		disabled={loading || !!fatal}
	/>
	<div class="body" bind:this={host}></div>
	<p class="sr-only" aria-live="polite">{announce}</p>
</div>

<style>
	.editor {
		display: grid;
		gap: var(--space-2);
	}

	.bar {
		position: sticky;
		top: 0;
		z-index: 1;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-1) 0;
		background: var(--color-bg);
	}

	.status {
		color: var(--color-muted);
		font-size: 0.875rem;
	}

	.status[data-state='conflict'],
	.status[data-state='auth-required'],
	.status[data-state='quota-error'],
	.status[data-state='invalid'],
	.status[data-state='too-large'] {
		color: #c62828;
	}

	.actions {
		display: flex;
		gap: var(--space-2);
	}

	button {
		min-height: 44px;
		padding: 0 var(--space-3);
		font: inherit;
	}

	.primary {
		font-weight: 700;
	}

	.title {
		font: inherit;
		font-size: 1.5rem;
		font-weight: 700;
		padding: var(--space-1) 0;
		border: none;
		border-bottom: 1px solid var(--color-border);
		background: transparent;
		color: inherit;
		width: 100%;
	}

	.body {
		min-height: 50dvh;
	}

	.body :global(.cm-editor) {
		font-size: 1rem;
		line-height: 1.7;
	}

	.body :global(.cm-editor.cm-focused) {
		outline: none;
	}

	.body :global(.cm-content) {
		font-family: var(--font-body);
		padding: var(--space-2) 0 40dvh;
		caret-color: var(--color-text);
	}

	.notice,
	.error {
		margin: 0;
		padding: var(--space-2);
		border: 1px solid var(--color-border);
		overflow-wrap: anywhere;
	}

	.error {
		color: #c62828;
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

	h3 {
		font-size: 0.9375rem;
		margin: 0;
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
