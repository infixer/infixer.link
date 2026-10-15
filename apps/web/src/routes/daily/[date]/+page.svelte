<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { OwnerSession, ownerFetch } from '#lib/owner/csrf.svelte.ts';
	import { pageSlug } from '#lib/paths.ts';
	import type { ApiErrorBody, DailyPageDto } from '@infixer-link/contracts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let owner = $state<OwnerSession | null>(null);
	let busy = $state(false);
	let message = $state('');

	onMount(async () => {
		owner = await OwnerSession.probe();
	});

	async function create() {
		if (!owner) return;
		busy = true;
		message = '';
		try {
			const res = await ownerFetch(owner, `/api/owner/v1/daily/${data.date}`, {
				method: 'POST',
				body: { mutationId: crypto.randomUUID() }
			});
			const body = (await res.json()) as DailyPageDto & Partial<ApiErrorBody>;
			if (!res.ok) {
				message =
					body.code === 'page_deleted'
						? 'この日の日記は削除されています。'
						: body.code === 'name_conflict'
							? '同じ名前のページが既にあります。'
							: (body.message ?? '作成できませんでした。');
				return;
			}
			await goto(resolve('/p/[id]/[[slug]]', { id: body.pageId, slug: pageSlug(body.title) }), {
				state: { edit: true }
			});
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>{data.date} - infixer.link</title>
</svelte:head>

<h1>{data.date}</h1>
<p class="empty" data-testid="daily-empty">この日の日記はまだありません。</p>

{#if owner}
	<button type="button" onclick={create} disabled={busy} data-testid="create-daily">
		{busy ? '作成中…' : 'この日の日記を書く'}
	</button>
	{#if message}<p role="alert">{message}</p>{/if}
{/if}

<nav class="days">
	<a href={resolve('/daily/[date]', { date: data.prev })}>← {data.prev}</a>
	<a href={resolve('/daily/[date]', { date: data.next })}>{data.next} →</a>
</nav>

<style>
	h1 {
		font-size: 1.5rem;
		margin: 0 0 var(--space-2);
	}

	.empty {
		color: var(--color-muted);
	}

	button {
		min-height: 44px;
		padding: 0 var(--space-3);
		font: inherit;
	}

	.days {
		display: flex;
		justify-content: space-between;
		margin-top: var(--space-4);
	}
</style>
