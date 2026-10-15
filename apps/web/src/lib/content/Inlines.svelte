<script lang="ts">
	import type { Inline } from '@infixer-link/content';
	import type { PageRefDto } from '@infixer-link/contracts';
	import { missingHref, pageHref } from './classes.ts';
	import Self from './Inlines.svelte';

	let { nodes, names }: { nodes: Inline[]; names: Record<string, PageRefDto> } = $props();
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- hrefs are built by pageHref / missingHref -->
{#each nodes as node, i (i)}
	{#if node.type === 'text'}{node.text}{:else if node.type === 'code'}<code class="ic"
			>{node.text}</code
		>{:else if node.type === 'link'}{@const page = names[node.name]}<a
			class="lk"
			class:missing={!page}
			href={page ? pageHref(page) : missingHref(node.name)}>{node.name}</a
		>{:else if node.type === 'tag'}{@const page = names[node.name]}<a
			class="tag"
			class:missing={!page}
			href={page ? pageHref(page) : missingHref(node.name)}>#{node.name}</a
		>{:else if node.type === 'url'}<a
			class="ext"
			href={node.url}
			target="_blank"
			rel="noopener nofollow ugc">{node.label}</a
		>{:else if node.type === 'asset'}<span class="asset">[画像]</span
		>{:else if node.type === 'math'}<code class="math">{node.text}</code
		>{:else if node.type === 'strong'}<strong
			class:w2={node.weight === 2}
			class:w3={(node.weight ?? 0) >= 3}><Self nodes={node.children} {names} /></strong
		>{:else if node.type === 'em'}<em><Self nodes={node.children} {names} /></em
		>{:else if node.type === 'strike'}<s><Self nodes={node.children} {names} /></s
		>{:else if node.type === 'underline'}<u><Self nodes={node.children} {names} /></u>{/if}
{/each}
