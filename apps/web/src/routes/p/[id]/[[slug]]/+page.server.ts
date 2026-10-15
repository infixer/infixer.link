import { env } from 'cloudflare:workers';
import { error } from '@sveltejs/kit';
import { getPublicPage, isDeletedPage } from '#lib/server/pages/service.ts';
import type { PageServerLoad } from './$types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const load: PageServerLoad = async ({ params }) => {
	if (!UUID_RE.test(params.id)) error(404, 'ページが見つかりません');
	const page = await getPublicPage(env.DB, params.id);
	if (!page) {
		if (await isDeletedPage(env.DB, params.id)) error(410, 'このページは削除されました');
		error(404, 'ページが見つかりません');
	}
	return { page };
};
