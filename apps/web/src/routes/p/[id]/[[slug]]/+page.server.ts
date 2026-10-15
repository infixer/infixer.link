import { env } from 'cloudflare:workers';
import { error } from '@sveltejs/kit';
import { parse } from '@infixer-link/content';
import { getPublicPage, isDeletedPage } from '#lib/server/pages/service.ts';
import { relatedPages, resolveNames } from '#lib/server/pages/graph.ts';
import { getPreviews } from '#lib/server/previews.ts';
import type { PageServerLoad } from './$types';

/** Plain-text summary for <meta> / OGP: the first lines of visible text. */
function summarize(parsed: ReturnType<typeof parse>): string {
	const parts: string[] = [];
	const visit = (nodes: ReturnType<typeof parse>['lines'][number]['inlines']) => {
		for (const n of nodes) {
			if (n.type === 'text' || n.type === 'code' || n.type === 'math') parts.push(n.text);
			else if (n.type === 'link' || n.type === 'tag') parts.push(n.name);
			else if (n.type === 'url') parts.push(n.label);
			else if ('children' in n) visit(n.children);
		}
	};
	for (const line of parsed.lines) {
		if (line.kind.startsWith('code') || line.kind === 'blank') continue;
		visit(line.inlines);
		parts.push(' ');
		if (parts.join('').length > 160) break;
	}
	const text = parts.join('').replace(/\s+/g, ' ').trim();
	return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const load: PageServerLoad = async ({ params }) => {
	if (!UUID_RE.test(params.id)) error(404, 'ページが見つかりません');
	const page = await getPublicPage(env.DB, params.id);
	if (!page) {
		if (await isDeletedPage(env.DB, params.id)) error(410, 'このページは削除されました');
		error(404, 'ページが見つかりません');
	}
	const parsed = parse(page.source);
	const [names, previews, related] = await Promise.all([
		resolveNames(env.DB, parsed.links),
		getPreviews(env.DB, parsed.cards),
		relatedPages(env.DB, page.id)
	]);
	return { page, names, previews, related, description: summarize(parsed) };
};
