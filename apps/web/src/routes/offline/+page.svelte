<!--
	This device's unsent changes and offline fallback (design §4.4, ADR 0015).

	- /offline: list of drafts not on the server yet (send now, open, download, delete).
	- /offline?draft={id}: the editor for a draft without a cached page — typically a page
	  created on this device while offline.
	- Served by the Service Worker in place of any page that is not on this device while
	  offline ("not available offline"), with today's diary as something that can be started.
-->
<script lang="ts">
	import { onMount, type Component } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { Draft } from '#lib/editor/autosave.ts';
	import { OwnerSession } from '#lib/owner/csrf.svelte.ts';
	import { isOwnerDevice } from '#lib/offline/device.ts';

	let owner = $state<OwnerSession | null>(null);
	let ownerDevice = $state(false);
	let drafts = $state<Draft[]>([]);
	let online = $state(true);
	let busy = $state(false);
	let message = $state('');
	let loaded = $state(false);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- lazily imported component
	let Editor = $state<Component<any> | null>(null);

	const fallback = $derived(page.url.pathname !== '/offline');
	const draftId = $derived(fallback ? null : page.url.searchParams.get('draft'));
	const openDraft = $derived(drafts.find((d) => d.pageId === draftId));

	async function store() {
		return (await import('#lib/editor/draft-store.ts')).idbDraftStore;
	}

	async function reload() {
		drafts = (await (await store()).all().catch(() => [])).sort((a, b) => b.savedAt - a.savedAt);
		loaded = true;
	}

	onMount(async () => {
		online = navigator.onLine;
		ownerDevice = isOwnerDevice();
		owner = await OwnerSession.probe();
		await reload();
		if (draftId && owner) Editor = (await import('#lib/editor/PageEditor.svelte')).default;
	});

	function status(d: Draft): string {
		if (d.conflict) return d.existingPageId ? '同じ日の日記が別の端末にあります' : '競合しています';
		if (d.error) return d.error;
		if (d.create) return 'この端末だけにあります（未公開）';
		return '未送信';
	}

	function href(d: Draft): string {
		// Pages that exist on the server open at their own URL (cached or online).
		return d.create || !online ? `${resolve('/offline')}?draft=${d.pageId}` : `/p/${d.pageId}`;
	}

	async function sendNow() {
		if (!owner) return;
		busy = true;
		message = '';
		const { runOutbox } = await import('#lib/offline/run.ts');
		const report = await runOutbox(owner);
		message =
			report.stopped === 'offline'
				? '接続できませんでした。接続が戻ると自動で送信します。'
				: report.stopped === 'auth'
					? 'ログインが必要です。ログインしてから、もう一度お試しください。'
					: `${report.sent} 件を送信しました。`;
		busy = false;
		await reload();
	}

	function download(list: Draft[]) {
		const text = JSON.stringify(
			{ exportedAt: new Date().toISOString(), format: 'infixer-link-drafts-v1', drafts: list },
			null,
			2
		);
		const a = document.createElement('a');
		a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
		a.download = `infixer-link-drafts-${Date.now()}.json`;
		a.click();
		URL.revokeObjectURL(a.href);
	}

	async function remove(d: Draft) {
		if (!confirm(`「${d.title}」の未送信の変更を削除しますか？（ダウンロードしてから削除します）`))
			return;
		download([d]);
		await (await store()).delete(d.pageId);
		await reload();
	}

	/** Starts (or reopens) today's diary on this device; it is created on the server later. */
	async function writeToday() {
		const { today, formatDailyDate } = await import('@infixer-link/time');
		const date = formatDailyDate(today());
		const existing = drafts.find((d) => d.create?.dailyDate === date);
		const id = existing?.pageId ?? crypto.randomUUID();
		if (!existing) {
			await (
				await store()
			).put({
				pageId: id,
				title: date,
				source: '',
				baseRevision: 0,
				create: { dailyDate: date },
				savedAt: Date.now()
			});
		}
		location.assign(`${resolve('/offline')}?draft=${id}`);
	}

	function created(pageId: string) {
		message = '公開しました。';
		void goto(resolve('/p/[id]/[[slug]]', { id: pageId, slug: '' }));
	}

	function editorDeleted() {
		void goto(resolve('/offline'));
	}
</script>

<svelte:head>
	<title>この端末の下書き - infixer.link</title>
	<meta name="robots" content="noindex" />
</svelte:head>

{#if openDraft && Editor && owner}
	{#key openDraft.pageId}
		<Editor
			pageId={openDraft.pageId}
			csrf={owner}
			initial={{
				title: openDraft.base?.title ?? openDraft.title,
				source: openDraft.base?.source ?? '',
				revision: openDraft.baseRevision,
				updatedAt: new Date(openDraft.savedAt).toISOString()
			}}
			names={{}}
			previews={{}}
			assets={{}}
			focus="body"
			onready={() => {}}
			ondeleted={editorDeleted}
			oncreated={created}
		/>
	{/key}
{:else}
	{#if fallback}
		<h1>オフラインです</h1>
		<p data-testid="not-cached">
			このページはまだこの端末に保存されていないため、オフラインでは開けません。接続が戻ってから開いてください。
		</p>
	{:else}
		<h1>この端末の下書き</h1>
	{/if}

	{#if ownerDevice}
		{#if !online || fallback}
			<p>
				<button type="button" onclick={writeToday} data-testid="write-today-offline"
					>今日の日記をこの端末で書く</button
				>
				（接続が戻ると公開します）
			</p>
		{/if}

		{#if loaded && drafts.length === 0}
			<p class="muted" data-testid="no-drafts">未送信の変更はありません。</p>
		{:else if drafts.length}
			<h2>未送信の変更（{drafts.length} 件）</h2>
			<ul class="drafts" data-testid="draft-list">
				{#each drafts as d (d.pageId)}
					<li>
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- built from resolve() or /p/ -->
						<a href={href(d)}>{d.title || '（無題）'}</a>
						<span class="muted">{status(d)}・{new Date(d.savedAt).toLocaleString('ja-JP')}</span>
						<button type="button" class="link" onclick={() => download([d])}>ダウンロード</button>
						<button type="button" class="link" onclick={() => remove(d)}>削除</button>
					</li>
				{/each}
			</ul>
			<p>
				{#if owner && online}
					<button type="button" onclick={sendNow} disabled={busy} data-testid="send-now"
						>今すぐ送信</button
					>
				{/if}
				<button type="button" onclick={() => download(drafts)}>すべてダウンロード</button>
			</p>
		{/if}
		{#if message}<p role="status">{message}</p>{/if}
	{/if}

	<p><a href={resolve('/')}>トップへ</a></p>
{/if}

<style>
	h1 {
		font-size: 1.5rem;
		margin: 0 0 var(--space-2);
	}

	h2 {
		font-size: 1rem;
		margin-top: var(--space-4);
	}

	.muted {
		color: var(--color-muted);
		font-size: 0.875rem;
	}

	.drafts {
		list-style: none;
		padding: 0;
	}

	.drafts li {
		padding: var(--space-2) 0;
		border-bottom: 1px solid var(--color-border);
		overflow-wrap: anywhere;
	}

	.drafts a {
		font-weight: 700;
		margin-right: var(--space-2);
	}

	button {
		min-height: 44px;
		font: inherit;
	}

	.link {
		min-height: 0;
		border: none;
		background: none;
		color: var(--color-muted);
		text-decoration: underline;
		cursor: pointer;
	}
</style>
