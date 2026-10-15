import { env } from 'cloudflare:workers';
import { error, redirect } from '@sveltejs/kit';
import { addDays, formatDailyDate, parseDailyDate } from '@infixer-link/time';
import { findDaily } from '#lib/server/pages/service.ts';
import { pagePath } from '#lib/paths.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, setHeaders }) => {
	const date = parseDailyDate(params.date);
	if (!date) error(404, '日付が正しくありません');
	const page = await findDaily(env.DB, params.date);
	if (page) redirect(302, pagePath(page));
	// Not created yet: a read-only placeholder. Creating it is an explicit owner action.
	setHeaders({ 'cache-control': 'no-cache' });
	return {
		date: formatDailyDate(date),
		prev: formatDailyDate(addDays(date, -1)),
		next: formatDailyDate(addDays(date, 1))
	};
};
