<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		api,
		errorMessage,
		passkeyAdd,
		signalAcceptedPasskeys,
		signalUnknownPasskey,
		withReauth
	} from '#lib/owner/client.ts';
	import type { IssuedTokenDto, TokenScope } from '@infixer-link/contracts';
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

	const syncPasskeyManager = () =>
		signalAcceptedPasskeys(
			data.rpId,
			data.userHandle,
			data.passkeys.map((p) => p.id)
		);

	onMount(syncPasskeyManager);

	function addPasskey() {
		return run(
			() => withReauth(csrf(), () => passkeyAdd(newName.trim() || 'パスキー', csrf())),
			'パスキーを追加しました。'
		);
	}

	async function removePasskey(id: string, name: string) {
		if (
			!confirm(`「${name}」を削除しますか？ このパスキーでログイン中の端末もログアウトされます。`)
		)
			return;
		await run(
			() =>
				withReauth(csrf(), () =>
					api(`/api/owner/v1/passkeys/${encodeURIComponent(id)}`, {
						method: 'DELETE',
						csrf: csrf()
					})
				),
			'パスキーを削除しました。'
		);
		if (!data.passkeys.some((p) => p.id === id)) {
			// Ask the platform passkey manager to hide the removed passkey (best effort).
			await signalUnknownPasskey(data.rpId, id);
			await syncPasskeyManager();
		}
	}

	// --- CLI tokens (ADR 0016) ---
	let tokenLabel = $state('');
	let tokenScopes = $state<Record<TokenScope, boolean>>({ read: true, write: true, backup: false });
	let tokenDays = $state(90);
	/** Shown once right after issuing; never stored. */
	let issued = $state<IssuedTokenDto | null>(null);

	function issueToken() {
		const scopes = (Object.keys(tokenScopes) as TokenScope[]).filter((s) => tokenScopes[s]);
		return run(async () => {
			issued = await withReauth(csrf(), () =>
				api<IssuedTokenDto>('/api/owner/v1/tokens', {
					body: { label: tokenLabel.trim() || 'CLI', scopes, expiresInDays: tokenDays },
					csrf: csrf()
				})
			);
			tokenLabel = '';
		}, 'トークンを発行しました。この画面を離れると二度と表示されません。');
	}

	function revokeToken(id: string, label: string) {
		if (!confirm(`「${label}」を失効させますか？ このトークンを使う CLI は使えなくなります。`))
			return;
		return run(
			() => api(`/api/owner/v1/tokens/${id}`, { method: 'DELETE', csrf: csrf() }),
			'トークンを失効させました。'
		);
	}

	const SCOPE_LABEL: Record<TokenScope, string> = {
		read: '読む（get・search・today）',
		write: '書く（append・put・create・import）',
		backup: '持ち出す（export・backup）'
	};

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

	/** Unsent data on this device decides what logging out offers (design §4.4). */
	let unsent = $state<{ drafts: number; images: number } | null>(null);

	async function logout() {
		const { localSummary } = await import('#lib/offline/local-data.ts');
		const summary = await localSummary();
		if (summary.drafts || summary.images) {
			unsent = summary;
			return;
		}
		await finishLogout('keep');
	}

	async function finishLogout(data: 'keep' | 'export-and-delete') {
		if (data === 'export-and-delete') {
			const { downloadLocalData, deleteLocalData } = await import('#lib/offline/local-data.ts');
			await downloadLocalData();
			await deleteLocalData();
		}
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
	<h2>CLI トークン</h2>
	<p class="hint">
		コマンド <code>infixer</code> 用のトークンです。発行にはパスキーでの確認が必要です。トークンは発行した直後に一度だけ表示されます。
	</p>
	{#if issued}
		<div class="issued" data-testid="issued-token">
			<p>
				「{issued.label}」のトークン（{issued.expiresAt.slice(0, 10)} まで有効）。<code
					>infixer auth login</code
				>
				に貼り付けるか、環境変数 <code>INFIXER_TOKEN</code> に設定してください。
			</p>
			<input
				type="text"
				readonly
				value={issued.token}
				aria-label="発行したトークン"
				onfocus={(e) => e.currentTarget.select()}
			/>
			<button type="button" onclick={() => (issued = null)}>閉じる（もう表示しません）</button>
		</div>
	{/if}
	<ul data-testid="tokens">
		{#each data.tokens as t (t.id)}
			<li class:revoked={t.revoked}>
				<span>
					{t.label}
					<br /><small
						>{t.scopes.join('・')}・{t.revoked
							? '失効済み'
							: `${t.expiresAt.slice(0, 10)} まで`}・最終使用 {t.lastUsedAt?.slice(0, 10) ??
							'なし'}</small
					>
				</span>
				{#if !t.revoked}
					<button type="button" disabled={busy} onclick={() => revokeToken(t.id, t.label)}
						>失効</button
					>
				{/if}
			</li>
		{/each}
	</ul>
	<fieldset class="token-form">
		<legend>新しいトークン</legend>
		<input
			type="text"
			bind:value={tokenLabel}
			maxlength="60"
			placeholder="名前（例：ノート PC）"
			aria-label="トークンの名前"
		/>
		{#each Object.entries(SCOPE_LABEL) as [scope, label] (scope)}
			<label
				><input type="checkbox" bind:checked={tokenScopes[scope as TokenScope]} /> {label}</label
			>
		{/each}
		<label
			>有効期間
			<select bind:value={tokenDays}>
				<option value={30}>30 日</option>
				<option value={90}>90 日</option>
				<option value={365}>1 年</option>
			</select></label
		>
		<button
			type="button"
			onclick={issueToken}
			disabled={busy || !Object.values(tokenScopes).some(Boolean)}
			data-testid="issue-token">発行する</button
		>
	</fieldset>
</section>

<section>
	{#if unsent}
		<div class="unsent" data-testid="logout-choice">
			<p>
				この端末には、まだ送信していない変更があります（ページ {unsent.drafts} 件、画像 {unsent.images}
				件）。
			</p>
			<button type="button" onclick={() => finishLogout('keep')} disabled={busy}
				>端末に残してログアウト（次にログインしたときに送信）</button
			>
			<button
				type="button"
				onclick={() => finishLogout('export-and-delete')}
				disabled={busy}
				data-testid="logout-export-delete">ダウンロードしてから削除してログアウト</button
			>
			<button type="button" onclick={() => (unsent = null)}>キャンセル</button>
		</div>
	{:else}
		<button type="button" onclick={logout} disabled={busy}>この端末からログアウト</button>
	{/if}
</section>

<style>
	.hint {
		color: var(--color-muted);
		font-size: 0.875rem;
	}

	.issued {
		display: grid;
		gap: var(--space-2);
		margin-bottom: var(--space-3);
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--color-border);
		border-radius: 0.5rem;
	}

	.issued input {
		width: 100%;
		font-family: ui-monospace, monospace;
	}

	.token-form {
		display: grid;
		gap: var(--space-2);
		justify-items: start;
	}

	.revoked {
		color: var(--color-muted);
	}

	.unsent {
		display: grid;
		gap: var(--space-2);
		justify-items: start;
	}

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
