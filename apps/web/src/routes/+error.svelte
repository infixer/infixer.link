<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
</script>

<svelte:head>
	<title>{page.status} - infixer.link</title>
</svelte:head>

<h1>{page.status}</h1>
<p>{page.error?.message ?? 'エラーが発生しました'}</p>
<p><a href={resolve('/')}>一覧へ戻る</a></p>

<style>
	h1 {
		font-size: 1.5rem;
		margin: 0 0 var(--space-2);
	}
</style>
