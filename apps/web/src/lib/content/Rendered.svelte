<!--
	SSR read view of link-text-v1 (ADR 0009). All text is escaped by Svelte; only
	http(s)/mailto URLs become links. Classes come from lib/content/classes.ts.
-->
<script lang="ts">
	import { parse } from '@infixer-link/content';
	import type { AssetDto, LinkPreviewDto, PageRefDto } from '@infixer-link/contracts';
	import { lineClass } from './classes.ts';
	import Inlines from './Inlines.svelte';
	import Video from './Video.svelte';

	interface Props {
		source: string;
		names: Record<string, PageRefDto>;
		previews: Record<string, LinkPreviewDto>;
		assets: Record<string, AssetDto>;
	}

	let { source, names, previews, assets }: Props = $props();
	let parsed = $derived(parse(source));
	let eagerAsset = $derived(parsed.assets.find((id) => assets[id]?.url));
	const NBSP = '\u00a0'; // keeps empty lines one line tall
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- external card URLs, not app routes -->
<div class="rendered" data-testid="page-source">
	{#each parsed.lines as line (line.index)}
		{@const card = line.url ? previews[line.url] : undefined}
		<div class={lineClass(line)} data-n={line.ordered}>
			{#if line.kind === 'blank' || line.kind === 'hr'}{NBSP}{:else if line.kind === 'code' || line.kind === 'code-close'}{line.text.slice(
					line.contentFrom
				) || NBSP}{:else if line.kind === 'code-open'}<span class="code-label"
					>{line.lang ?? ''}</span
				>{NBSP}{:else if line.video}<Video
					video={line.video}
					preview={card}
				/>{:else if card?.ok && card.title}<a
					class="card"
					class:has-image={!!card.image}
					href={line.url}
					target="_blank"
					rel="noopener nofollow ugc"
					><span class="card-text"
						><span class="card-title">{card.title}</span>{#if card.description}<span
								class="card-desc">{card.description}</span
							>{/if}<span class="card-host">{card.siteName ?? card.host}</span></span
					>{#if card.image}<img
							class="card-image"
							src={card.image.url}
							width={card.image.width}
							height={card.image.height}
							alt=""
							loading="lazy"
							decoding="async"
						/>{/if}</a
				>{:else}<Inlines nodes={line.inlines} {names} {assets} {eagerAsset} />{/if}
		</div>
	{/each}
</div>
