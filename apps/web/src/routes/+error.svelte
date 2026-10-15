<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { OwnerSession, ownerFetch } from '#lib/owner/csrf.svelte.ts';

	// A deleted page (410) stays at its URL; only the owner sees the restore action.
	let owner = $state<OwnerSession | null>(null);
	let message = $state('');
	const deletedPageId = $derived(page.status === 410 ? page.params.id : undefined);

	onMount(async () => {
		if (deletedPageId) owner = await OwnerSession.probe();
	});

	async function restore() {
		if (!owner || !deletedPageId) return;
		const latest = await fetch(`/api/owner/v1/pages/${deletedPageId}`, { cache: 'no-store' });
		if (!latest.ok) return (message = '元に戻せませんでした。');
		const { revision } = (await latest.json()) as { revision: number };
		const res = await ownerFetch(owner, `/api/owner/v1/pages/${deletedPageId}/restore`, {
			method: 'POST',
			body: { baseRevision: revision, mutationId: crypto.randomUUID() }
		});
		if (!res.ok) return (message = '元に戻せませんでした。');
		location.reload();
	}
</script>

<svelte:head>
	<title>{page.status} - infixer.link</title>
</svelte:head>

<h1>{page.status}</h1>
<p>{page.error?.message ?? 'エラーが発生しました'}</p>
{#if owner && deletedPageId}
	<button type="button" onclick={restore} data-testid="restore">元に戻す</button>
	{#if message}<p role="alert">{message}</p>{/if}
{/if}
<p><a href={resolve('/')}>一覧へ戻る</a></p>

<style>
	h1 {
		font-size: 1.5rem;
		margin: 0 0 var(--space-2);
	}

	button {
		min-height: 44px;
		padding: 0 var(--space-3);
		font: inherit;
	}
</style>
