/**
 * Service Worker (design §4.4, ADR 0015).
 *
 * - App shell: the build's immutable files, static files and the /offline page are cached
 *   per version at install. Cache-first.
 * - Public pages: HTML navigations and SvelteKit's __data.json are network-first; a copy of
 *   each successful public response is kept (latest 200) so visited pages open offline.
 *   A page that was never fetched shows /offline ("not on this device") instead.
 * - Never touched: /api/* (owner API, auth, writes), /owner/*, /media/*, redirects,
 *   responses marked no-store, other origins and non-GET requests.
 * - Updates wait: no skipWaiting at install. The page asks the waiting worker to take
 *   over only when the owner presses "更新" (after drafts were flushed).
 */
import { self } from '$app/service-worker';
import { assets, immutable } from '$app/manifest';
import { version } from '$app/env';

const SHELL = `shell-${version}`;
const PAGES = 'pages-v1';
const OFFLINE = '/offline';
const MAX_PAGES = 200;

const absolute = (path: string) => `/${path.replace(/^\//, '')}`;
const shellFiles = [...immutable, ...assets].map((f) => absolute(f.path));
const shellSet = new Set(shellFiles);

self.addEventListener('install', (event) => {
	event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll([...shellFiles, OFFLINE])));
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key.startsWith('shell-') && key !== SHELL) await caches.delete(key);
			}
			await self.clients.claim();
		})()
	);
});

self.addEventListener('message', (event) => {
	if (event.data === 'skip-waiting') void self.skipWaiting();
});

function bypass(url: URL): boolean {
	return (
		url.origin !== self.location.origin ||
		url.pathname.startsWith('/api/') ||
		url.pathname.startsWith('/owner') ||
		url.pathname.startsWith('/media/') ||
		url.pathname === '/service-worker.js'
	);
}

function storable(res: Response): boolean {
	return (
		res.status === 200 &&
		res.type === 'basic' &&
		!res.redirected &&
		!/no-store/i.test(res.headers.get('cache-control') ?? '')
	);
}

async function remember(request: Request, response: Response) {
	const cache = await caches.open(PAGES);
	await cache.put(request, response);
	const keys = await cache.keys();
	for (const old of keys.slice(0, Math.max(0, keys.length - MAX_PAGES))) await cache.delete(old);
}

async function networkFirst(event: FetchEvent, isData: boolean): Promise<Response> {
	const { request } = event;
	try {
		const response = await fetch(request);
		if (storable(response)) event.waitUntil(remember(request, response.clone()));
		return response;
	} catch {
		const cache = await caches.open(PAGES);
		const cached =
			(await cache.match(request)) ??
			(isData ? await cache.match(request, { ignoreSearch: true }) : undefined);
		if (cached) return cached;
		if (isData) return Response.error();
		return (
			(await caches.match(OFFLINE)) ??
			new Response('オフラインです', {
				status: 503,
				headers: { 'content-type': 'text/plain; charset=utf-8' }
			})
		);
	}
}

self.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;
	const url = new URL(request.url);
	if (bypass(url)) return;

	if (shellSet.has(url.pathname)) {
		event.respondWith(caches.match(url.pathname).then((hit) => hit ?? fetch(request)));
		return;
	}
	const isData = url.pathname.endsWith('/__data.json');
	if (request.mode === 'navigate' || isData) event.respondWith(networkFirst(event, isData));
});
