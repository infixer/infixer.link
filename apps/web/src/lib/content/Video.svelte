<!--
	YouTube embed (ADR 0014): a thumbnail with a play button; the privacy-enhanced player
	(youtube-nocookie.com) is loaded only after the reader presses play. Without
	JavaScript it is a link to YouTube. The editor builds the same DOM (live.ts).
-->
<script lang="ts">
	import { youtubeEmbedUrl, youtubeWatchUrl, type Video } from '@infixer-link/content';
	import type { LinkPreviewDto } from '@infixer-link/contracts';

	let { video, preview }: { video: Video; preview?: LinkPreviewDto } = $props();
	let playing = $state(false);
	const title = $derived(preview?.title ?? 'YouTube の動画');

	function play(event: MouseEvent) {
		// Let modified clicks open YouTube in a new tab as usual.
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
			return;
		event.preventDefault();
		playing = true;
	}
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- external YouTube URL -->
<span class="video" data-testid="video">
	{#if playing}
		<iframe
			class="video-frame"
			src={youtubeEmbedUrl(video)}
			{title}
			allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
			allowfullscreen
			referrerpolicy="strict-origin-when-cross-origin"
		></iframe>
	{:else}
		<a
			class="video-facade"
			href={youtubeWatchUrl(video)}
			target="_blank"
			rel="noopener nofollow ugc"
			aria-label={`${title}を再生`}
			onclick={play}
			>{#if preview?.image}<img
					class="video-poster"
					src={preview.image.url}
					width={preview.image.width}
					height={preview.image.height}
					alt=""
					loading="lazy"
					decoding="async"
				/>{/if}<span class="video-play" aria-hidden="true"></span>{#if preview?.title}<span
					class="video-title">{preview.title}</span
				>{/if}</a
		>
	{/if}
</span>
