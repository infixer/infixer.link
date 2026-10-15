<script lang="ts">
	import { resolve } from '$app/paths';
	import { pageSlug } from '#lib/paths.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>infixer.link</title>
</svelte:head>

<p class="today">
	今日は <time datetime={data.today} data-testid="today">{data.today}</time>（{data.timeZone}）
</p>

{#if data.pages.length === 0}
	<p class="empty">まだページがありません。</p>
{:else}
	<ul class="pages" data-testid="page-list">
		{#each data.pages as page (page.id)}
			<li>
				<a href={resolve('/p/[id]/[[slug]]', { id: page.id, slug: pageSlug(page.title) })}
					>{page.title}</a
				>
				<time datetime={page.updatedAt}>{page.updatedAt.slice(0, 10)}</time>
			</li>
		{/each}
	</ul>
{/if}

{#if data.nextCursor}
	<a class="more" href={resolve(`/?cursor=${encodeURIComponent(data.nextCursor)}`)}>さらに表示</a>
{/if}

<style>
	.today,
	.empty {
		color: var(--color-muted);
	}

	.pages {
		list-style: none;
		margin: var(--space-3) 0;
		padding: 0;
		border-top: 1px solid var(--color-border);
	}

	.pages li {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-2) 0;
		border-bottom: 1px solid var(--color-border);
	}

	.pages a {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.pages time {
		flex: none;
		color: var(--color-muted);
		font-size: 0.875rem;
	}
</style>
