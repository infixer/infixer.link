<script lang="ts">
	import { errorMessage, passkeySetup } from '#lib/owner/client.ts';

	let token = $state('');
	let name = $state('');
	let busy = $state(false);
	let message = $state('');

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		message = '';
		try {
			await passkeySetup(token.trim(), name.trim() || 'パスキー');
			location.assign('/owner/settings');
		} catch (error) {
			message = errorMessage(error);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>初期設定 - infixer.link</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<h1>パスキーの登録</h1>
<p>
	管理用コマンド（<code>pnpm --filter web owner:grant</code
	>）で発行したセットアップコードを貼り付けてください。 コードは10分で失効し、一度しか使えません。
</p>

<form onsubmit={submit}>
	<label>
		セットアップコード
		<input
			type="password"
			bind:value={token}
			autocomplete="off"
			spellcheck="false"
			required
			minlength="32"
		/>
	</label>
	<label>
		このパスキーの名前（任意）
		<input type="text" bind:value={name} maxlength="60" placeholder="MacBook など" />
	</label>
	<button type="submit" disabled={busy}>{busy ? '登録中…' : 'パスキーを登録'}</button>
</form>
{#if message}
	<p class="error" role="alert">{message}</p>
{/if}

<style>
	h1 {
		font-size: 1.5rem;
		margin: 0 0 var(--space-2);
	}

	form {
		display: grid;
		gap: var(--space-3);
		max-width: 28rem;
	}

	label {
		display: grid;
		gap: var(--space-1);
	}

	input,
	button {
		min-height: 44px;
		font: inherit;
		padding: 0 var(--space-2);
	}

	.error {
		color: #c62828;
	}
</style>
