<!--
	Device status under the header (design §4.4, ADR 0015): offline, changes not sent yet,
	and app updates. Unsent changes are sent in the background when the app opens, the
	network returns or the tab becomes visible; what cannot be sent stays listed.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { OwnerSession } from '../owner/csrf.svelte.ts';
	import type { OutboxReport } from './outbox.ts';
	import { isOwnerDevice } from './device.ts';
	import { applyUpdate, registerServiceWorker, sw } from './sw.svelte.ts';

	let online = $state(true);
	let owner: OwnerSession | null = null;
	let waiting = $state(0);
	let report = $state<OutboxReport | null>(null);
	let updating = $state(false);

	async function sync() {
		// Readers never load the outbox code or the Service Worker: owner devices only.
		if (!isOwnerDevice()) {
			if ((await OwnerSession.probe()) === null) return; // probe() marks owner devices
		}
		void registerServiceWorker();
		const { runOutbox, unsentCount } = await import('./run.ts');
		if (!navigator.onLine) {
			waiting = await unsentCount();
			return;
		}
		owner ??= await OwnerSession.probe();
		if (owner && !owner.offline) report = await runOutbox(owner);
		// Pages open in an editor are sent by the editor itself.
		waiting = Math.max(0, (await unsentCount()) - (report?.busy ?? 0));
	}

	onMount(() => {
		online = navigator.onLine;
		const up = () => {
			online = true;
			owner = null; // re-probe: the session may have been checked while offline
			void sync();
		};
		const down = () => (online = false);
		const visible = () => {
			if (document.visibilityState === 'visible') void sync();
		};
		window.addEventListener('online', up);
		window.addEventListener('offline', down);
		document.addEventListener('visibilitychange', visible);
		window.addEventListener('infixer:drafts-changed', visible);
		void sync();
		return () => {
			window.removeEventListener('online', up);
			window.removeEventListener('offline', down);
			document.removeEventListener('visibilitychange', visible);
			window.removeEventListener('infixer:drafts-changed', visible);
		};
	});

	async function update() {
		updating = true;
		await applyUpdate();
	}
</script>

{#if !online || waiting > 0 || sw.updateReady}
	<div class="status" role="status" data-testid="device-status">
		{#if !online}
			<p data-testid="offline-banner">
				オフラインです。この端末で開いたことのあるページだけ表示できます。書いた内容は端末に保存され、接続が戻ると送信します。
			</p>
		{/if}
		{#if waiting > 0}
			<p data-testid="unsent-banner">
				この端末に未送信の変更が {waiting} 件あります{report?.stopped === 'auth'
					? '（ログインが必要です）'
					: report?.conflicts
						? `（${report.conflicts} 件は競合しています）`
						: ''}。
				<a href={resolve('/offline')}>確認する</a>
			</p>
		{/if}
		{#if sw.updateReady}
			<p data-testid="update-banner">
				新しいバージョンがあります。
				<button type="button" onclick={update} disabled={updating}>更新する</button>
				（書いている内容は端末に保存してから再読み込みします）
			</p>
		{/if}
	</div>
{/if}

<style>
	.status {
		margin: 0 0 var(--space-3);
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--color-border);
		border-radius: 0.5rem;
		background: var(--color-surface);
		font-size: 0.875rem;
	}

	.status p {
		margin: 0;
	}

	.status p + p {
		margin-top: var(--space-1);
	}

	button {
		min-height: 32px;
		font: inherit;
	}
</style>
