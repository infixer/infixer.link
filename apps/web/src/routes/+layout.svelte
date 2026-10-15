<script lang="ts">
	import '#lib/styles/base.css';
	import '#lib/styles/content.css';
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import favicon from '#lib/assets/favicon.svg';
	import NewPageButton from '#lib/owner/NewPageButton.svelte';
	import ThemeSwitch from '#lib/ThemeSwitch.svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// Like infixer.net: the bar hides while scrolling down and returns when scrolling up.
	let hidden = $state(false);
	onMount(() => {
		let last = window.scrollY;
		let ticking = false;
		const onScroll = () => {
			if (ticking) return;
			ticking = true;
			requestAnimationFrame(() => {
				const y = window.scrollY;
				hidden = y > 0 && y > last;
				last = y;
				ticking = false;
			});
		};
		window.addEventListener('scroll', onScroll, { passive: true });
		return () => window.removeEventListener('scroll', onScroll);
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<header class="site" class:hidden data-testid="site-header">
	<div class="bar">
		<a href={resolve('/')} class="brand">infixer.link</a>
		<nav>
			<NewPageButton />
			<a href={resolve('/search')} class="navlink" data-testid="nav-search">検索</a>
			<a href={resolve('/today')} class="navlink" data-sveltekit-preload-data="off">今日</a>
			<ThemeSwitch />
		</nav>
	</div>
</header>

<main>
	{@render children()}
</main>

<style>
	/* Dark bar in both themes, fixed to the top (infixer.net). */
	.site {
		position: fixed;
		inset: 0 0 auto;
		z-index: 40;
		padding-top: env(safe-area-inset-top);
		background: var(--color-header-bg);
		color: var(--color-header-text);
		transition: transform 0.3s;
	}

	.site.hidden:not(:focus-within) {
		transform: translateY(-100%);
	}

	.bar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-3);
		height: var(--header-height);
		max-width: calc(var(--content-width) + 2 * var(--space-3));
		margin: 0 auto;
		padding: 0 var(--space-3) 0 max(var(--space-3), env(safe-area-inset-left));
	}

	.brand {
		color: var(--color-header-text);
		font-weight: 700;
		text-decoration: none;
	}

	nav {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.navlink {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 var(--space-2);
		color: var(--color-header-text);
		text-decoration: none;
	}

	.navlink:hover {
		color: var(--color-header-muted);
	}

	main {
		max-width: var(--content-width);
		margin: 0 auto;
		padding: var(--space-4) var(--space-3);
	}
</style>
