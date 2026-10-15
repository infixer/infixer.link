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

	// SvelteKit only puts the per-request nonce into script-src. CodeMirror injects its
	// base styles in a <style nonce> element (EditorView.cspNonce), so allow the same
	// nonce for styles; without it the caret / selection layers lose their positioning.
	const csp = headers.get('content-security-policy');
	const nonce = csp && /'nonce-([^']+)'/.exec(csp)?.[1];
	if (csp && nonce && !/style-src[^;]*'nonce-/.test(csp)) {
		headers.set(
			'content-security-policy',
			csp.replace(/style-src ([^;]*)/, `style-src $1 'nonce-${nonce}'`)
		);
	}

	if (path.startsWith('/owner')) {
		headers.set('cache-control', 'no-store');
		headers.set('x-robots-tag', 'noindex, nofollow');
	} else if (!path.startsWith('/api/') && !headers.has('cache-control')) {
		// v1: public HTML is revalidated every time; no long CDN caching (design §12.1).
		headers.set('cache-control', 'no-cache');
	}
	return response;
};
