import { env } from 'cloudflare:workers';
import { createApi } from '#lib/server/api/app.ts';
import { authConfig } from '#lib/server/config.ts';
import type { RequestHandler } from './$types';

let api: ReturnType<typeof createApi> | undefined;

/** Every /api/* request is handled by the Hono app (ADR 0006). */
export const fallback: RequestHandler = ({ request }) => {
	api ??= createApi({
		db: env.DB,
		config: authConfig(),
		allowLocalPreviews: env.LINK_PREVIEW_ALLOW_LOCAL === 'true',
		pending: env.PENDING,
		media: env.MEDIA,
		mediaBaseUrl: env.MEDIA_BASE_URL,
		timeZone: env.SITE_TIME_ZONE
	});
	return api.fetch(request);
};
