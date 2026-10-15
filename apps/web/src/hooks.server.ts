import type { Handle } from '@sveltejs/kit/hooks';

/**
 * Security headers for every response (design §9.8). /api/* responses are produced
 * by Hono and get the same headers here. Owner pages are never cached or indexed.
 */
export const handle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	const path = event.url.pathname;
	const headers = response.headers;

	headers.set('x-content-type-options', 'nosniff');
	headers.set('referrer-policy', 'strict-origin-when-cross-origin');
	headers.set('x-frame-options', 'DENY');
	headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');

	if (path.startsWith('/owner')) {
		headers.set('cache-control', 'no-store');
		headers.set('x-robots-tag', 'noindex, nofollow');
	} else if (!path.startsWith('/api/') && !headers.has('cache-control')) {
		// v1: public HTML is revalidated every time; no long CDN caching (design §12.1).
		headers.set('cache-control', 'no-cache');
	}
	return response;
};
