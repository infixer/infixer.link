import { env } from 'cloudflare:workers';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * Local development only: serves the MEDIA bucket when MEDIA_BASE_URL is "/media".
 * In staging / production images come from the R2 custom domain + CDN, never via the app
 * Worker (design §10.1), so this route answers 404 there.
 */
export const GET: RequestHandler = async ({ params, request }) => {
	if (env.MEDIA_BASE_URL !== '/media') error(404, 'Not found');
	if (!/^originals\/[0-9a-f]{64}\.(jpg|png|gif|webp)$/.test(params.key)) error(404, 'Not found');
	const object = await env.MEDIA.get(params.key, { onlyIf: request.headers });
	if (!object) error(404, 'Not found');
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('etag', object.httpEtag);
	headers.set('cache-control', 'public, max-age=31536000, immutable');
	headers.set('x-content-type-options', 'nosniff');
	if (!('body' in object) || !object.body) return new Response(null, { status: 304, headers });
	return new Response(object.body, { headers });
};
