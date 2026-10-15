<!-- Owner-only "新規" action in the header: creates a page and puts the cursor in its title. -->
<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { ApiErrorBody, MutationResult } from '@infixer-link/contracts';
	import { OwnerSession, ownerFetch } from './csrf.svelte.ts';
	import { pageSlug } from '../paths.ts';

	let owner = $state<OwnerSession | null>(null);
	let busy = $state(false);

	onMount(async () => {
		owner = await OwnerSession.probe();
	});

	function untitled(attempt: number) {
		const stamp = new Intl.DateTimeFormat('sv-SE', {
			timeZone: 'Asia/Tokyo',
			dateStyle: 'short',
			timeStyle: 'medium'
		}).format(new Date());
		return attempt === 0 ? `無題 ${stamp}` : `無題 ${stamp} (${attempt + 1})`;
	}

	/** Offline: the page is created on this device and published when the network returns. */
	async function createLocal() {
		const { idbDraftStore } = await import('../editor/draft-store.ts');
		const id = crypto.randomUUID();
		await idbDraftStore.put({
			pageId: id,
			// The name is only checked when the page reaches the server: make it unlikely to collide.
			title: `${untitled(0)} ${id.slice(0, 4)}`,
			source: '',
			baseRevision: 0,
			create: {},
			savedAt: Date.now()
		});
		location.assign(`${resolve('/offline')}?draft=${id}`);
	}

	async function create() {
		if (!owner || busy) return;
		busy = true;
		if (owner.offline || !navigator.onLine) {
			await createLocal().finally(() => (busy = false));
			return;
		}
		try {
			for (let attempt = 0; attempt < 5; attempt++) {
				const title = untitled(attempt);
				const res = await ownerFetch(owner, '/api/owner/v1/pages', {
					method: 'POST',
					body: { mutationId: crypto.randomUUID(), title, format: 'link-text-v1', source: '' }
				});
				if (res.ok) {
					const { pageId } = (await res.json()) as MutationResult;
					await goto(resolve('/p/[id]/[[slug]]', { id: pageId, slug: pageSlug(title) }), {
						state: { edit: 'title' }
					});
					return;
				}
				const error = (await res.json().catch(() => null)) as ApiErrorBody | null;
				if (error?.code !== 'name_conflict') break;
			}
		} finally {
			busy = false;
		}
	}
</script>

{#if owner}
	<button type="button" onclick={create} disabled={busy} data-testid="new-page">新規</button>
{/if}

<style>
	button {
		min-height: 44px;
		padding: 0 var(--space-2);
		border: none;
		background: none;
		color: var(--color-header-text);
		font: inherit;
		cursor: pointer;
	}
</style>
