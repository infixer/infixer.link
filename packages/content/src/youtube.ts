/**
 * YouTube URLs that render as an embedded player (ADR 0014).
 * Only the video id and start time are taken from the URL; nothing else is trusted.
 */
export interface Video {
	provider: 'youtube';
	id: string;
	/** Start position in seconds (0 = beginning). */
	start: number;
}

const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);

/** `t=90`, `t=1m30s`, `start=90` → seconds. */
function seconds(value: string | null): number {
	if (!value) return 0;
	if (/^\d+$/.test(value)) return Math.min(Number(value), 86_400);
	const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
	if (!m || !value) return 0;
	return Math.min(Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0), 86_400);
}

export function youtubeVideo(raw: string): Video | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	const host = url.hostname.toLowerCase();
	let id: string | null = null;
	if (host === 'youtu.be') {
		id = url.pathname.split('/')[1] ?? null;
	} else if (HOSTS.has(host)) {
		const [, first, second] = url.pathname.split('/');
		if (first === 'watch') id = url.searchParams.get('v');
		else if (first === 'shorts' || first === 'embed' || first === 'live') id = second ?? null;
	}
	if (!id || !ID_RE.test(id)) return null;
	return {
		provider: 'youtube',
		id,
		start: seconds(url.searchParams.get('t') ?? url.searchParams.get('start'))
	};
}

/** Canonical watch URL (used for oEmbed and as the no-JavaScript link). */
export function youtubeWatchUrl(video: Video): string {
	return `https://www.youtube.com/watch?v=${video.id}${video.start ? `&t=${video.start}s` : ''}`;
}

/** Privacy-enhanced player URL, loaded only after the reader presses play. */
export function youtubeEmbedUrl(video: Video): string {
	return `https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1${video.start ? `&start=${video.start}` : ''}`;
}

export function youtubeThumbnailUrl(video: Video): string {
	return `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;
}
