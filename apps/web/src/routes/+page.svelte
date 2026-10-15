<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>infixer.link</title>
</svelte:head>

<main>
	<h1>infixer.link</h1>
	<p>
		今日は <time datetime={data.today} data-testid="today">{data.today}</time>（{data.timeZone}）
	</p>
</main>

<style>
	main {
		max-width: var(--content-width);
		margin: 0 auto;
		padding: var(--space-4) var(--space-3);
	}

	h1 {
		font-size: 1.5rem;
		margin: 0 0 var(--space-3);
	}
</style>
