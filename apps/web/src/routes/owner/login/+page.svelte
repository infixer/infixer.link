<script lang="ts">
	import { page } from '$app/state';
	import { safeReturnTo } from '#lib/paths.ts';
	import { errorMessage, passkeyAuthenticate } from '#lib/owner/client.ts';

	let busy = $state(false);
	let message = $state('');

	async function login() {
		busy = true;
		message = '';
		try {
			await passkeyAuthenticate('login');
			// Full navigation so server-rendered pages see the new session.
			location.assign(safeReturnTo(page.url.searchParams.get('returnTo')));
		} catch (error) {
			message = errorMessage(error);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>ログイン - infixer.link</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<h1>ログイン</h1>
<p>登録済みのパスキーでログインします。</p>
<button type="button" onclick={login} disabled={busy}>
	{busy ? '確認中…' : 'パスキーでログイン'}
</button>
{#if message}
	<p class="error" role="alert">{message}</p>
{/if}

<style>
	h1 {
		font-size: 1.5rem;
		margin: 0 0 var(--space-2);
	}

	button {
		min-height: 44px;
		padding: 0 var(--space-4);
		font: inherit;
	}

	.error {
		color: #c62828;
	}
</style>
