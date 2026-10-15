import { env } from 'cloudflare:workers';
import { DEFAULT_TIME_ZONE, formatDailyDate, today } from '@garden/time';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const timeZone = env.SITE_TIME_ZONE ?? DEFAULT_TIME_ZONE;
	return {
		today: formatDailyDate(today(timeZone)),
		timeZone
	};
};
