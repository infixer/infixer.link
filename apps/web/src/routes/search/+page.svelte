<script lang="ts">
	import { onMount } from 'svelte';
	import { afterNavigate, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { SearchDto } from '@infixer-link/contracts';
	import { pageHref } from '#lib/content/classes.ts';
	import { createLiveSearch } from '#lib/search/live.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** Results fetched while typing; SSR data is used until the first live result. */
	let live = $state<SearchDto | null>(null);
	let failed = $state(false);
	let input: HTMLInputElement | undefined = $state();
	let list: HTMLOListElement | undefined = $state();

	const result = $derived(live ?? data.result);
	const offset = $derived(live ? 0 : data.offset);

	const searchUrl = (q: string, from = 0) => {
		const query = `q=${encodeURIComponent(q)}${from ? `&offset=${from}` : ''}`;
		return `${resolve('/search')}?${query}`;
	};

	const search = createLiveSearch<SearchDto>({
		fetchResults: async (q, signal) => {
			const res = await fetch(`/api/public/v1/search?q=${encodeURIComponent(q)}`, { signal });
			if (!res.ok) throw new Error(`search failed: ${res.status}`);
			return res.json();
		},
		onResult: (q, r) => {
			live = r;
			failed = false;
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- searchUrl uses resolve()
			replaceState(searchUrl(q), {});
		},
		onError: () => {
			failed = true;
		}
	});

	function update(q: string, now = false) {
		if (!q.trim()) {
			search.cancel();
			live = { query: '', hits: [], nextOffset: null };
			replaceState(resolve('/search'), {});
			return;
		}
		if (now) void search.run(q);
		else search.schedule(q);
	}

	// A real navigation (e.g. "さらに表示") brings new SSR data.
	afterNavigate(() => {
		live = null;
	});

	onMount(() => {
		// Arriving without a query: start typing right away.
		if (!data.q) input?.focus();
		return () => search.cancel();
	});

	function oninput(event: Event & { currentTarget: HTMLInputElement }) {
		// Wait for IME composition to end (compositionend) instead of searching romaji / partials.
		if (event instanceof InputEvent && event.isComposing) return;
		update(event.currentTarget.value);
	}

	function onsubmit(event: SubmitEvent) {
		event.preventDefault();
		update(input?.value ?? '', true);
	}

	/** Arrow keys move between the box and the results; Enter follows the focused link. */
	function onkeydown(event: KeyboardEvent) {
		if (event.isComposing || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) {
			if (event.key === 'Escape' && document.activeElement !== input) input?.focus();
			return;
		}
		const links = [...(list?.querySelectorAll<HTMLAnchorElement>('a.hit') ?? [])];
		const at = links.indexOf(document.activeElement as HTMLAnchorElement);
		const next = event.key === 'ArrowDown' ? at + 1 : at - 1;
		if (next < 0) input?.focus();
		else links[Math.min(next, links.length - 1)]?.focus();
		event.preventDefault();
	}
</script>

<svelte:head>
	<title>{result.query ? `${result.query} の検索` : '検索'} - infixer.link</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<svelte:window {onkeydown} />

<h1>検索</h1>

<form method="GET" action={resolve('/search')} role="search" {onsubmit}>
	<input
		bind:this={input}
		type="search"
		name="q"
		value={data.q}
		{oninput}
		oncompositionend={(e) => update(e.currentTarget.value)}
		aria-label="検索語"
		placeholder="タイトルと本文から探す"
		autocomplete="off"
		enterkeyhint="search"
		maxlength="200"
		data-testid="search-input"
	/>
	<button type="submit">検索</button>
</form>

<p class="status" aria-live="polite" data-testid="search-status">
	{#if failed}
		検索できませんでした。通信を確認してください。
	{:else if !result.query}
		1 文字から探せます。複数の語はスペースで区切ります。
	{:else if result.hits.length === 0 && offset === 0}
		「{result.query}」は見つかりませんでした。
	{:else}
		「{result.query}」の検索結果{offset ? `（${offset + 1} 件目から）` : ''}
	{/if}
</p>

{#if result.hits.length}
	<ol class="hits" bind:this={list} data-testid="search-results">
		{#each result.hits as hit (hit.id)}
			<li>
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- pageHref builds a /p/ path -->
				<a class="hit" href={pageHref(hit)}>
					<span class="title">{hit.title}</span>
					{#if hit.match === 'alias'}
						<span class="note">（旧名「{hit.alias}」）</span>
					{/if}
				</a>
				{#if hit.excerpt.length}
					<p class="excerpt">
						{#each hit.excerpt as part, i (i)}{#if part.hit}<mark>{part.text}</mark
								>{:else}{part.text}{/if}{/each}
					</p>
				{/if}
				<time datetime={hit.updatedAt}>{hit.updatedAt.slice(0, 10)}</time>
			</li>
		{/each}
	</ol>
{/if}

{#if result.nextOffset !== null}
	<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- searchUrl uses resolve() -->
	<a class="more" href={searchUrl(result.query, result.nextOffset)}>さらに表示</a>
{/if}

<style>
	h1 {
		font-size: 1.5rem;
		margin: 0 0 var(--space-3);
	}

	form {
		display: flex;
		gap: var(--space-2);
	}

	input {
		flex: 1;
		min-width: 0;
		min-height: 44px;
		padding: 0 var(--space-2);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-bg);
		color: var(--color-text);
		font: inherit;
	}

	button {
		min-height: 44px;
	}

	.status {
		color: var(--color-muted);
		font-size: 0.875rem;
	}

	.hits {
		list-style: none;
		margin: var(--space-3) 0;
		padding: 0;
		border-top: 1px solid var(--color-border);
	}

	.hits li {
		padding: var(--space-2) 0;
		border-bottom: 1px solid var(--color-border);
	}

	.hit {
		display: block;
		overflow-wrap: anywhere;
	}

	.title {
		font-weight: 700;
	}

	.note,
	.hits time {
		color: var(--color-muted);
		font-size: 0.875rem;
	}

	.excerpt {
		margin: var(--space-1) 0;
		overflow-wrap: anywhere;
		font-size: 0.9375rem;
	}

	mark {
		background: var(--color-selection);
		color: inherit;
	}
</style>
