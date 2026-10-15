<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	// Phase 1 shows the plain source; the link-text-v1 renderer arrives in Phase 3.
	let lines = $derived(data.page.source.split('\n'));
</script>

<svelte:head>
	<title>{data.page.title} - infixer.link</title>
</svelte:head>

<article>
	<h1>{data.page.title}</h1>
	<p class="meta">
		更新 <time datetime={data.page.updatedAt}>{data.page.updatedAt.slice(0, 10)}</time>
	</p>
	<div class="source" data-testid="page-source">
		{#each lines as line, i (i)}
			<div class="line">{line || ' '}</div>
		{/each}
	</div>
</article>

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
</style>
