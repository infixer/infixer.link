import { env } from 'cloudflare:workers';
import { error } from '@sveltejs/kit';
import { DEFAULT_TIME_ZONE, formatDailyDate, today } from '@infixer-link/time';
import { listPages } from '#lib/server/pages/service.ts';
import { ApiError } from '#lib/server/http.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const timeZone = env.SITE_TIME_ZONE ?? DEFAULT_TIME_ZONE;
	try {
		const list = await listPages(env.DB, {
			cursor: url.searchParams.get('cursor') ?? undefined,
			mediaBaseUrl: env.MEDIA_BASE_URL
		});
		return { today: formatDailyDate(today(timeZone)), timeZone, ...list };
	} catch (e) {
		if (e instanceof ApiError && e.code === 'bad_request')
			error(400, '一覧の位置指定が正しくありません');
		throw e;
	}
};
