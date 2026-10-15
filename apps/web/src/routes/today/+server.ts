import { env } from 'cloudflare:workers';
import { redirect } from '@sveltejs/kit';
import { DEFAULT_TIME_ZONE, formatDailyDate, today } from '@infixer-link/time';
import type { RequestHandler } from './$types';

/**
 * Resolves "today" in the configured time zone at request time (design §5) and
 * redirects to the date URL. GET never creates a page.
 */
export const GET: RequestHandler = ({ setHeaders }) => {
	setHeaders({ 'cache-control': 'no-store' });
	redirect(302, `/daily/${formatDailyDate(today(env.SITE_TIME_ZONE ?? DEFAULT_TIME_ZONE))}`);
};
