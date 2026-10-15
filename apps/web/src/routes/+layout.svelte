<script lang="ts">
	import '#lib/styles/base.css';
	import { resolve } from '$app/paths';
	import favicon from '#lib/assets/favicon.svg';
	import NewPageButton from '#lib/owner/NewPageButton.svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<header class="site">
	<a href={resolve('/')} class="brand">infixer.link</a>
	<nav>
		<NewPageButton />
		<a href={resolve('/today')} class="today" data-sveltekit-preload-data="off">今日</a>
	</nav>
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

	.site {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.brand {
		color: var(--color-text);
		font-weight: 700;
		text-decoration: none;
	}

	nav {
		display: flex;
		align-items: center;
	}

	.today {
		padding: var(--space-2);
	}

	main {
		max-width: var(--content-width);
		margin: 0 auto;
		padding: var(--space-3) var(--space-3) var(--space-4);
	}
</style>
