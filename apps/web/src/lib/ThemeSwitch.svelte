<!--
	Theme switch like infixer.net: light / dark buttons; pressing the active one again
	returns to "follow the system". The initial class is set by the inline script in app.html.
-->
<script lang="ts">
	import { onMount } from 'svelte';

	type Choice = 'light' | 'dark' | null;
	let choice = $state<Choice>(null);
	let systemDark = $state(false);
	let status = $state('');

	function read(): Choice {
		try {
			const saved = localStorage.getItem('theme');
			return saved === 'light' || saved === 'dark' ? saved : null;
		} catch {
			return null;
		}
	}

	function apply() {
		const dark = choice === null ? systemDark : choice === 'dark';
		const root = document.documentElement;
		root.classList.toggle('dark', dark);
		root.classList.toggle('light', !dark);
		status =
			choice === null
				? `システム設定に従っています（現在: ${systemDark ? 'ダーク' : 'ライト'}モード）`
				: `${choice === 'dark' ? 'ダーク' : 'ライト'}モードに固定中です`;
	}

	function select(value: 'light' | 'dark') {
		choice = choice === value ? null : value;
		try {
			if (choice) localStorage.setItem('theme', choice);
			else localStorage.removeItem('theme');
		} catch {
			// Storage unavailable (private mode): the choice lasts for this page only.
		}
		apply();
	}

	onMount(() => {
		const media = matchMedia('(prefers-color-scheme: dark)');
		choice = read();
		systemDark = media.matches;
		apply();
		const onChange = () => {
			systemDark = media.matches;
			if (choice === null) apply();
		};
		media.addEventListener('change', onChange);
		return () => media.removeEventListener('change', onChange);
	});

	const label = (value: 'light' | 'dark') => {
		const name = value === 'dark' ? 'ダークモード' : 'ライトモード';
		return choice === value
			? `${name}に固定中。もう一度押すとシステム設定に戻ります`
			: `${name}に固定する`;
	};
</script>

<div class="switch" role="group" aria-label="テーマ設定" data-testid="theme-switch">
	<button
		type="button"
		aria-pressed={choice === 'light'}
		aria-label={label('light')}
		title={label('light')}
		onclick={() => select('light')}
		data-theme-value="light"
	>
		<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
			<circle cx="12" cy="12" r="5" />
			<path
				d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
			/>
		</svg>
	</button>
	<button
		type="button"
		aria-pressed={choice === 'dark'}
		aria-label={label('dark')}
		title={label('dark')}
		onclick={() => select('dark')}
		data-theme-value="dark"
	>
		<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
			<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
		</svg>
	</button>
	<p class="sr-only" role="status" aria-live="polite">{status}</p>
</div>

<style>
	.switch {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 2px;
		border-radius: 999px;
		background: oklch(100% 0 0 / 10%);
	}

	button {
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		padding: 0;
		border: none;
		border-radius: 999px;
		background: transparent;
		color: var(--color-header-muted);
		cursor: pointer;
	}

	button:hover {
		color: var(--color-header-text);
	}

	button[aria-pressed='true'] {
		background: var(--color-header-text);
		color: var(--color-header-bg);
	}

	button:focus-visible {
		outline: 2px solid var(--color-header-text);
		outline-offset: 2px;
	}

	svg {
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
