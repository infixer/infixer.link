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
	<!-- Cosense-style cards: the page's first image / card / video thumbnail, else its first lines. -->
	<ul class="cards" data-testid="page-list">
		{#each data.pages as page, i (page.id)}
			<li>
				<a
					class="page-card"
					class:has-thumb={!!page.thumbnail}
					href={resolve('/p/[id]/[[slug]]', { id: page.id, slug: pageSlug(page.title) })}
					><span class="title">{page.title}</span>{#if page.thumbnail}<img
							class="thumb"
							src={page.thumbnail.url}
							width={page.thumbnail.width}
							height={page.thumbnail.height}
							alt=""
							loading={i < 8 ? 'eager' : 'lazy'}
							decoding="async"
						/>{:else if page.excerpt.length}<span class="text"
							>{#each page.excerpt as line, n (n)}<span>{line}</span>{/each}</span
						>{/if}</a
				>
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

	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
		gap: var(--space-2);
		list-style: none;
		margin: var(--space-3) 0;
		padding: 0;
	}

	.page-card {
		display: flex;
		flex-direction: column;
		aspect-ratio: 1;
		overflow: hidden;
		padding: var(--space-2) var(--space-2) 0;
		border: 1px solid var(--color-border);
		border-radius: 0.5rem;
		background: var(--color-surface);
		color: inherit;
		text-decoration: none;
		transition: box-shadow 0.2s;
	}

	.page-card:hover,
	.page-card:focus-visible {
		box-shadow: 0 4px 12px oklch(0% 0 0 / 12%);
	}

	.title {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		flex: none;
		overflow: hidden;
		overflow-wrap: anywhere;
		font-weight: 700;
		line-height: 1.4;
	}

	.thumb {
		flex: 1;
		min-height: 0;
		width: calc(100% + 2 * var(--space-2));
		height: auto;
		margin: var(--space-2) calc(-1 * var(--space-2)) 0;
		object-fit: cover;
		background: var(--color-border);
	}

	.text {
		flex: 1;
		min-height: 0;
		margin-top: var(--space-1);
		overflow: hidden;
		color: var(--color-muted);
		font-size: 0.8125rem;
		line-height: 1.5;
		overflow-wrap: anywhere;
	}

	.text span {
		display: block;
	}
</style>
