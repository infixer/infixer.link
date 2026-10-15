<script lang="ts">
	import '#lib/styles/base.css';
	import { resolve } from '$app/paths';
	import favicon from '#lib/assets/favicon.svg';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<header class="site">
	<a href={resolve('/')} class="brand">infixer.link</a>
</header>

<main>
	{@render children()}
</main>

<style>
	.site {
		max-width: var(--content-width);
		margin: 0 auto;
		padding: var(--space-3) var(--space-3) 0;
	}

	.brand {
		color: var(--color-text);
		font-weight: 700;
		text-decoration: none;
	}

	main {
		max-width: var(--content-width);
		margin: 0 auto;
		padding: var(--space-3) var(--space-3) var(--space-4);
	}
</style>
