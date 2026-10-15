<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import type { ApiErrorBody, MutationResult } from '@infixer-link/contracts';
	import { OwnerSession, ownerFetch } from '#lib/owner/csrf.svelte.ts';
	import { pageHref } from '#lib/content/classes.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let owner = $state<OwnerSession | null>(null);
	let busy = $state(false);
	let message = $state('');

	onMount(async () => {
		owner = await OwnerSession.probe();
	});

	/** Creating is an explicit owner action; visiting a missing link never creates a page. */
	async function create() {
		if (!owner) return;
		busy = true;
		try {
			const res = await ownerFetch(owner, '/api/owner/v1/pages', {
				method: 'POST',
				body: {
					mutationId: crypto.randomUUID(),
					title: data.name,
					format: 'link-text-v1',
					source: ''
				}
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
				message = body?.message ?? '作成できませんでした。';
				return;
			}
			const { pageId } = (await res.json()) as MutationResult;
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- pageHref builds a /p/ path
			await goto(pageHref({ id: pageId, title: data.name }), { state: { edit: 'body' } });
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>{data.name} - infixer.link</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<h1>{data.name}</h1>
<p class="empty" data-testid="missing-page">このページはまだありません。</p>
{#if owner}
	<button type="button" onclick={create} disabled={busy} data-testid="create-missing"
		>このページを作る</button
	>
	{#if message}<p role="alert">{message}</p>{/if}
{/if}

{#if data.linkedFrom.length}
	<h2>このページへのリンク</h2>
	<ul>
		{#each data.linkedFrom as p (p.id)}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- pageHref builds a /p/ path -->
			<li><a href={pageHref(p)}>{p.title}</a></li>
		{/each}
	</ul>
{/if}

<style>
	h1 {
		font-size: 1.5rem;
		margin: 0 0 var(--space-2);
		overflow-wrap: anywhere;
	}

	h2 {
		font-size: 1rem;
		margin-top: var(--space-4);
	}

	.empty {
		color: var(--color-muted);
	}

	button {
		min-height: 44px;
		padding: 0 var(--space-3);
		font: inherit;
	}
</style>
