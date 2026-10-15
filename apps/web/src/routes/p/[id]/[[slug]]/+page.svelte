<!--
	Public page and, for the signed-in owner only, in-place editing on the same URL
	(design §4.1, §9.1). The editor and CodeMirror are imported after the session probe.
-->
<script lang="ts">
	import { onMount, type Component } from 'svelte';
	import { page as appPage } from '$app/state';
	import { invalidateAll, replaceState } from '$app/navigation';
	import { OwnerSession, ownerFetch } from '#lib/owner/csrf.svelte.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Shown = { title: string; source: string; updatedAt: string };
	let override = $state<{ id: string; shown: Shown } | null>(null);
	let shown = $derived<Shown>(override?.id === data.page.id ? override.shown : data.page);
	let lines = $derived(shown.source.split('\n'));

	let owner = $state<OwnerSession | null>(null);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- lazily imported component
	let Editor = $state<Component<any> | null>(null);
	let editing = $state(false);
	let deletedRevision = $state<number | null>(null);
	let message = $state('');

	onMount(async () => {
		owner = await OwnerSession.probe();
		if (owner && appPage.state.edit) {
			replaceState('', {});
			await startEdit();
		}
	});

	async function startEdit() {
		if (!owner || editing) return;
		Editor ??= (await import('#lib/editor/PageEditor.svelte')).default;
		editing = true;
	}

	function onContentClick(event: MouseEvent) {
		if (!owner || editing) return;
		if ((event.target as HTMLElement).closest('a, button')) return;
		if (window.getSelection()?.toString()) return; // selecting text is not an edit request
		void startEdit();
	}

	function closed(next: { title: string; source: string; revision: number }) {
		override = {
			id: data.page.id,
			shown: { title: next.title, source: next.source, updatedAt: new Date().toISOString() }
		};
		editing = false;
	}

	function deleted(revision: number) {
		editing = false;
		deletedRevision = revision;
	}

	async function restore() {
		if (!owner || deletedRevision === null) return;
		const res = await ownerFetch(owner, `/api/owner/v1/pages/${data.page.id}/restore`, {
			method: 'POST',
			body: { baseRevision: deletedRevision, mutationId: crypto.randomUUID() }
		});
		if (!res.ok) {
			message = '元に戻せませんでした。';
			return;
		}
		deletedRevision = null;
		override = null;
		await invalidateAll();
	}
</script>

<svelte:head>
	<title>{shown.title} - infixer.link</title>
</svelte:head>

{#if deletedRevision !== null}
	<section class="deleted" data-testid="deleted">
		<p>このページは削除されました。</p>
		<button type="button" onclick={restore}>元に戻す</button>
		{#if message}<p role="alert">{message}</p>{/if}
	</section>
{:else if editing && Editor && owner}
	<Editor pageId={data.page.id} csrf={owner} onclose={closed} ondeleted={deleted} />
{:else}
	<article>
		{#if owner}
			<div class="owner-bar">
				<button type="button" onclick={startEdit} data-testid="edit">編集</button>
			</div>
		{/if}
		<h1>{shown.title}</h1>
		<p class="meta">
			更新 <time datetime={shown.updatedAt}>{shown.updatedAt.slice(0, 10)}</time>
		</p>
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (the 編集 button is the keyboard path) -->
		<div class="source" class:editable={!!owner} data-testid="page-source" onclick={onContentClick}>
			{#each lines as line, i (i)}
				<div class="line">{line || ' '}</div>
			{/each}
		</div>
	</article>
{/if}

<style>
	h1 {
		font-size: 1.5rem;
		margin: 0;
		overflow-wrap: anywhere;
	}

	.meta {
		margin: var(--space-1) 0 var(--space-3);
		color: var(--color-muted);
		font-size: 0.875rem;
	}

	.line {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.editable {
		cursor: text;
		min-height: 6rem;
	}

	.owner-bar {
		display: flex;
		justify-content: flex-end;
	}

	button {
		min-height: 44px;
		padding: 0 var(--space-3);
		font: inherit;
	}

	.deleted {
		padding: var(--space-3);
		border: 1px solid var(--color-border);
	}
</style>
