import { env } from 'cloudflare:workers';
import { error, redirect } from '@sveltejs/kit';
import { nameKey } from '@infixer-link/content';
import { resolveNames } from '#lib/server/pages/graph.ts';
import { pageHref } from '#lib/content/classes.ts';
import type { PageServerLoad } from './$types';

/** A link target by name: redirects to the page, or shows who links to it (Cosense-style). */
export const load: PageServerLoad = async ({ params }) => {
	const name = nameKey(params.name);
	if (!name || name.length > 400) error(404, 'ページが見つかりません');
	const found = (await resolveNames(env.DB, [name]))[name];
	if (found) redirect(302, pageHref(found));
	const { results } = await env.DB.prepare(
		`SELECT p.id, p.title FROM page_links l JOIN pages p ON p.id = l.source_page_id AND p.deleted_at IS NULL
		 WHERE l.target_name_key = ? ORDER BY p.updated_at DESC LIMIT 50`
	)
		.bind(name)
		.all<{ id: string; title: string }>();
	return { name, linkedFrom: results };
};
