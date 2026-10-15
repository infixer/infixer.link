<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage, passkeyAdd, withReauth } from '#lib/owner/client.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let busy = $state(false);
	let message = $state('');
	let newName = $state('');

	async function run(action: () => Promise<unknown>, done?: string) {
		busy = true;
		message = '';
		try {
			await action();
			message = done ?? '';
			await invalidateAll();
		} catch (error) {
			message = errorMessage(error);
		} finally {
			busy = false;
		}
	}

	const csrf = () => data.csrfToken;

	function addPasskey() {
		return run(
			() => withReauth(csrf(), () => passkeyAdd(newName.trim() || 'パスキー', csrf())),
			'パスキーを追加しました。'
		);
	}

	function removePasskey(id: string, name: string) {
		if (
			!confirm(`「${name}」を削除しますか？ このパスキーでログイン中の端末もログアウトされます。`)
		)
			return;
		return run(
			() =>
				withReauth(csrf(), () =>
					api(`/api/owner/v1/passkeys/${encodeURIComponent(id)}`, {
						method: 'DELETE',
						csrf: csrf()
					})
				),
			'パスキーを削除しました。'
		);
	}

	function revokeSession(id: string) {
		return run(() => api(`/api/owner/v1/sessions/${id}`, { method: 'DELETE', csrf: csrf() }));
	}

	function revokeOthers() {
		return run(
			() =>
				withReauth(csrf(), () =>
					api('/api/owner/v1/sessions/revoke-others', { body: {}, csrf: csrf() })
				),
			'他の端末をログアウトしました。'
		);
	}

	async function logout() {
		await run(() => api('/api/auth/v1/logout', { body: {}, csrf: csrf() }));
		location.assign('/');
	}
</script>

<svelte:head>
	<title>設定 - infixer.link</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<h1>設定</h1>

{#if message}
	<p class="message" role="status">{message}</p>
{/if}

<section>
	<h2>パスキー</h2>
	<ul data-testid="passkeys">
		{#each data.passkeys as key (key.id)}
			<li>
				<span>
					{key.name}
					{#if key.current}<small>（この端末のログインに使用）</small>{/if}
					<br /><small
						>登録 {key.createdAt.slice(0, 10)}{key.backedUp ? '・同期パスキー' : ''}</small
					>
				</span>
				<button
					type="button"
					disabled={busy || data.passkeys.length <= 1}
					onclick={() => removePasskey(key.id, key.name)}
				>
					削除
				</button>
			</li>
		{/each}
	</ul>
	<div class="row">
		<input
			type="text"
			bind:value={newName}
			maxlength="60"
			placeholder="新しいパスキーの名前"
			aria-label="新しいパスキーの名前"
		/>
		<button type="button" onclick={addPasskey} disabled={busy}>パスキーを追加</button>
	</div>
	<p class="hint">紛失に備えて、別の端末やセキュリティキーも登録しておくことをおすすめします。</p>
</section>

<section>
	<h2>ログイン中の端末</h2>
	<ul data-testid="sessions">
		{#each data.sessions as s (s.id)}
			<li>
				<span>
					{s.userAgent || '不明な端末'}
					{#if s.current}<small>（この端末）</small>{/if}
					<br /><small>最終利用 {s.lastSeenAt.slice(0, 16).replace('T', ' ')} UTC</small>
				</span>
				{#if !s.current}
					<button type="button" disabled={busy} onclick={() => revokeSession(s.id)}
						>ログアウト</button
					>
				{/if}
			</li>
		{/each}
	</ul>
	<button type="button" onclick={revokeOthers} disabled={busy || data.sessions.length <= 1}
		>他の端末をすべてログアウト</button
	>
</section>

<section>
	<button type="button" onclick={logout} disabled={busy}>この端末からログアウト</button>
</section>

<style>
	h1 {
		font-size: 1.5rem;
		margin: 0 0 var(--space-3);
	}

	h2 {
		font-size: 1.125rem;
		margin: var(--space-4) 0 var(--space-2);
	}

	ul {
		list-style: none;
		margin: 0 0 var(--space-3);
		padding: 0;
		border-top: 1px solid var(--color-border);
	}

	li {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2) 0;
		border-bottom: 1px solid var(--color-border);
		overflow-wrap: anywhere;
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	input,
	button {
		min-height: 44px;
		font: inherit;
		padding: 0 var(--space-2);
	}

	small,
	.hint {
		color: var(--color-muted);
		font-size: 0.8125rem;
	}

	.message {
		padding: var(--space-2);
		border: 1px solid var(--color-border);
	}
</style>
