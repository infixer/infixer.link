<!--
	Three-way conflict resolution (design §4.3, ADR 0015): this device's text, the server's
	latest revision and their common base. Changes on different lines are combined;
	where both sides changed the same lines, the owner picks per block. Nothing is saved
	until the owner presses a button, and "use the server version" downloads this
	device's text first.
-->
<script lang="ts">
	import { merge3, mergeValue, resolve, type Choice } from '@infixer-link/sync';
	import type { ServerPage, Snapshot } from './autosave.ts';

	interface Props {
		/** Common base; unknown for drafts saved before Phase 6 (then everything is one block). */
		base: Snapshot | undefined;
		local: Snapshot;
		server: ServerPage;
		onsave: (snapshot: Snapshot) => void;
		ontakeserver: () => void;
	}

	let { base, local, server, onsave, ontakeserver }: Props = $props();

	const result = $derived(merge3(base?.source ?? '', local.source, server.source));
	const titleMerged = $derived(
		base
			? mergeValue(base.title, local.title, server.title)
			: local.title === server.title
				? local.title
				: null
	);
	/** Choice per conflict block (default: this device). */
	let choices = $state<Record<number, Choice>>({});
	let titleChoice = $state<'ours' | 'theirs'>('ours');

	const conflictIndex = (i: number) =>
		result.chunks.slice(0, i).filter((c) => c.kind === 'conflict').length;

	function save() {
		const title = titleMerged ?? (titleChoice === 'ours' ? local.title : server.title);
		const picked = Array.from({ length: result.conflicts }, (_, n) => choices[n] ?? 'ours');
		onsave({ title, source: result.merged ?? resolve(result.chunks, picked) });
	}

	const LABEL = { ours: 'この端末', theirs: 'サーバー', both: '両方で同じ変更' } as const;
	const shown = (lines: string[]) => (lines.length ? lines.join('\n') : '（空）');
</script>

<section class="conflict" data-testid="conflict">
	<p>
		別の端末などで、このページが先に更新されていました（版 {server.revision}）。
		{#if result.conflicts === 0}
			<strong>重なる変更はありません。</strong>両方の変更をまとめて保存できます。
		{:else}
			同じ箇所が両方で変更されています（{result.conflicts} か所）。それぞれ残す方を選んでください。
		{/if}
	</p>

	{#if titleMerged === null}
		<fieldset class="title-choice" data-testid="conflict-title">
			<legend>タイトル</legend>
			<label
				><input type="radio" bind:group={titleChoice} value="ours" /> この端末：{local.title}</label
			>
			<label
				><input type="radio" bind:group={titleChoice} value="theirs" />
				サーバー：{server.title}</label
			>
		</fieldset>
	{/if}

	<div class="merge" data-testid="conflict-merge">
		{#each result.chunks as chunk, i (i)}
			{#if chunk.kind === 'stable'}
				{#if chunk.lines.length > 4}
					<pre class="stable">{chunk.lines.slice(0, 1).join('\n')}</pre>
					<p class="gap">（変更のない {chunk.lines.length - 2} 行）</p>
					<pre class="stable">{chunk.lines.slice(-1).join('\n')}</pre>
				{:else}
					<pre class="stable">{chunk.lines.join('\n')}</pre>
				{/if}
			{:else if chunk.kind === 'conflict'}
				{@const n = conflictIndex(i)}
				<fieldset class="block" data-testid="conflict-block">
					<legend>重なった変更 {n + 1}</legend>
					<div class="sides">
						<div>
							<h4>この端末</h4>
							<pre class="ours">{shown(chunk.ours)}</pre>
						</div>
						<div>
							<h4>サーバー</h4>
							<pre class="theirs">{shown(chunk.theirs)}</pre>
						</div>
					</div>
					<div class="choices">
						{#each [['ours', 'この端末'], ['theirs', 'サーバー'], ['both', '両方を残す']] as [value, label] (value)}
							<label
								><input
									type="radio"
									name="conflict-{n}"
									{value}
									checked={(choices[n] ?? 'ours') === value}
									onchange={() => (choices[n] = value as Choice)}
								/>
								{label}</label
							>
						{/each}
					</div>
				</fieldset>
			{:else}
				<div class="change {chunk.kind}">
					<span class="who">{LABEL[chunk.kind]}の変更</span>
					{#if chunk.base.length}<pre class="removed">{chunk.base.join('\n')}</pre>{/if}
					{#if chunk.lines.length}<pre class="added">{chunk.lines.join('\n')}</pre>{/if}
				</div>
			{/if}
		{/each}
	</div>

	<div class="actions">
		<button type="button" class="primary" onclick={save} data-testid="conflict-save"
			>{result.conflicts === 0 ? 'まとめて保存' : '選んだ内容で保存'}</button
		>
		<button type="button" onclick={() => onsave(local)} data-testid="conflict-keep-local"
			>この端末の内容で上書き</button
		>
		<button type="button" onclick={ontakeserver} data-testid="conflict-take-server"
			>サーバーの版を使う（この端末の内容はファイルに保存）</button
		>
	</div>
</section>

<style>
	.conflict {
		margin-bottom: var(--space-3);
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--color-danger);
		border-radius: 0.5rem;
	}

	.merge {
		max-height: 60dvh;
		overflow: auto;
		margin: var(--space-2) 0;
	}

	pre {
		margin: 0;
		padding: 0 var(--space-2);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-family: var(--font-body);
		font-size: 0.9375rem;
	}

	.stable {
		color: var(--color-muted);
	}

	.gap {
		margin: 0;
		padding: 0 var(--space-2);
		color: var(--color-muted);
		font-size: 0.8125rem;
	}

	.change {
		margin: var(--space-1) 0;
		border-left: 3px solid var(--color-border);
	}

	.change.ours {
		border-color: oklch(62% 0.17 250);
	}

	.change.theirs {
		border-color: oklch(65% 0.15 150);
	}

	.who {
		display: block;
		padding: 0 var(--space-2);
		color: var(--color-muted);
		font-size: 0.75rem;
	}

	.removed {
		text-decoration: line-through;
		color: var(--color-muted);
	}

	.block {
		margin: var(--space-2) 0;
		border: 1px solid var(--color-danger);
		border-radius: 0.375rem;
	}

	.sides {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		gap: var(--space-2);
	}

	h4 {
		margin: 0;
		font-size: 0.8125rem;
	}

	.ours,
	.theirs {
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--color-border);
	}

	.choices,
	.title-choice {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
		margin-top: var(--space-1);
	}

	.choices label,
	.title-choice label {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-height: 44px;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.actions button {
		min-height: 44px;
		padding: 0 var(--space-3);
		font: inherit;
	}

	.primary {
		font-weight: 700;
	}
</style>
