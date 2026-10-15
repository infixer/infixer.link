<!-- Related pages below the content (design §11.2): links, backlinks, shared link targets. -->
<script lang="ts">
	import type { RelatedDto } from '@infixer-link/contracts';
	import { missingHref, pageHref } from './classes.ts';

	let { related }: { related: RelatedDto } = $props();
	const href = (t: RelatedDto['links'][number]) =>
		t.page ? pageHref(t.page) : missingHref(t.name);
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- hrefs are built by pageHref / missingHref -->
{#if related.links.length || related.backlinks.length || related.shared.length}
	<aside class="related" data-testid="related">
		{#if related.backlinks.length}
			<section>
				<h2>このページへのリンク</h2>
				<ul>
					{#each related.backlinks as p (p.id)}<li><a href={pageHref(p)}>{p.title}</a></li>{/each}
				</ul>
			</section>
		{/if}
		{#each related.shared as group (group.target.page?.id ?? group.target.name)}
			<section>
				<h2>
					<a href={href(group.target)} class:missing={!group.target.page}
						>{group.target.page?.title ?? group.target.name}</a
					>
				</h2>
				<ul>
					{#each group.pages as p (p.id)}<li><a href={pageHref(p)}>{p.title}</a></li>{/each}
					{#if group.more}<li class="more"><a href={href(group.target)}>もっと見る</a></li>{/if}
				</ul>
			</section>
		{/each}
		{#if related.links.length}
			<section>
				<h2>リンク先</h2>
				<ul>
					{#each related.links as t (t.page?.id ?? t.name)}
						<li><a href={href(t)} class:missing={!t.page}>{t.page?.title ?? t.name}</a></li>
					{/each}
				</ul>
			</section>
		{/if}
	</aside>
{/if}

<style>
	.related {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
		gap: var(--space-3);
		margin-top: var(--space-4);
		padding-top: var(--space-3);
		border-top: 1px solid var(--color-border);
	}

	h2 {
		font-size: 0.875rem;
		margin: 0 0 var(--space-1);
		color: var(--color-muted);
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		font-size: 0.9375rem;
	}

	li {
		padding: 2px 0;
		overflow-wrap: anywhere;
	}

	.missing {
		color: var(--color-missing);
	}

	.more {
		font-size: 0.8125rem;
	}
</style>
