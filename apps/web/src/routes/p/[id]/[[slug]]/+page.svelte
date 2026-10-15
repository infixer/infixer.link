<!--
	Public page. For the signed-in owner the same URL is directly editable (design §4.1,
	§9.1): after the session probe the editor is mounted underneath the read view, styled
	identically, and the two are swapped in one frame once it is ready — no edit mode.
-->
<script lang="ts">
	import { onMount, type Component } from 'svelte';
	import { page as appPage } from '$app/state';
	import { invalidateAll, replaceState } from '$app/navigation';
	import { OwnerSession, ownerFetch } from '#lib/owner/csrf.svelte.ts';
	import Rendered from '#lib/content/Rendered.svelte';
	import Related from '#lib/content/Related.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let owner = $state<OwnerSession | null>(null);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- lazily imported component
	let Editor = $state<Component<any> | null>(null);
	let editorReady = $state(false);
	let focus = $state<'title' | 'body' | null>(null);
	let deletedRevision = $state<number | null>(null);
	let message = $state('');

	onMount(async () => {
		owner = await OwnerSession.probe();
		if (!owner) return;
		Editor = (await import('#lib/editor/PageEditor.svelte')).default;
	});

	// Navigating to another page remounts the editor: show the read view until it is ready.
	let shownId = '';
	$effect.pre(() => {
		if (data.page.id !== shownId) {
			shownId = data.page.id;
			editorReady = false;
			deletedRevision = null;
			// The route component is reused across pages, so read the request on every page change.
			const requested = appPage.state.edit;
			focus = requested ? (requested === true ? 'body' : requested) : null;
		}
	});

	function ready() {
		editorReady = true;
		// The focus request is one-shot; reloading the page must not re-focus.
		if (appPage.state.edit) replaceState('', {});
	}

	function deleted(revision: number) {
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
		editorReady = false;
		Editor = null;
		await invalidateAll();
		Editor = (await import('#lib/editor/PageEditor.svelte')).default;
	}
</script>

<svelte:head>
	<title>{data.page.title} - infixer.link</title>
	<meta name="description" content={data.description} />
	<meta property="og:type" content="article" />
	<meta property="og:title" content={data.page.title} />
	<meta property="og:description" content={data.description} />
	<meta property="og:site_name" content="infixer.link" />
</svelte:head>

{#if deletedRevision !== null}
	<section class="deleted" data-testid="deleted">
		<p>このページは削除されました。</p>
		<button type="button" onclick={restore}>元に戻す</button>
		{#if message}<p role="alert">{message}</p>{/if}
	</section>
{:else}
	<div class="stack">
		<article class:hidden={editorReady} aria-hidden={editorReady}>
			<h1>{data.page.title}</h1>
			<p class="meta">
				更新 <time datetime={data.page.updatedAt}>{data.page.updatedAt.slice(0, 10)}</time>
			</p>
			<div class="source">
				<Rendered source={data.page.source} names={data.names} previews={data.previews} />
			</div>
		</article>
		{#if owner && Editor}
			{#key data.page.id}
				<div class="layer" class:hidden={!editorReady}>
					<Editor
						pageId={data.page.id}
						csrf={owner}
						initial={data.page}
						names={data.names}
						previews={data.previews}
						{focus}
						onready={ready}
						ondeleted={deleted}
					/>
				</div>
			{/key}
		{/if}
	</div>
	<Related related={data.related} />
{/if}

<style>
	/* Read view and editor occupy the same grid cell, so swapping them does not move anything. */
	.stack {
		display: grid;
	}

	.stack > * {
		grid-area: 1 / 1;
		min-width: 0;
	}

	.hidden {
		visibility: hidden;
		pointer-events: none;
	}

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

	.source {
		min-height: 6rem;
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
