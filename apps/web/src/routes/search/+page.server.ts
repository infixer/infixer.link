import { env } from 'cloudflare:workers';
import { searchPages } from '#lib/server/pages/search.ts';
import type { PageServerLoad } from './$types';

/** SSR search (works without JavaScript); the page upgrades to search-as-you-type. */
export const load: PageServerLoad = async ({ url }) => {
	const q = url.searchParams.get('q') ?? '';
	const offset = Number.parseInt(url.searchParams.get('offset') ?? '', 10) || 0;
	return { q, offset, result: await searchPages(env.DB, q, { offset }) };
};
