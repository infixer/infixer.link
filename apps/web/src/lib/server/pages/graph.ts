/**
 * Link graph reads (design §11.2): name resolution for rendering, related pages and
 * title suggestions. Every query is bounded; hubs never expand without limits.
 */
import type { PageRefDto, RelatedDto, TitleSuggestionDto } from '@infixer-link/contracts';
import { nameKey } from '@infixer-link/content';

const LIMITS = { links: 50, backlinks: 50, sharedGroups: 5, sharedPerGroup: 10 } as const;

/** Resolves link names (titles or aliases) to live pages in one query. */
export async function resolveNames(
	db: D1Database,
	names: string[]
): Promise<Record<string, PageRefDto>> {
	const keys = [...new Set(names.map(nameKey))].slice(0, 1000);
	if (keys.length === 0) return {};
	const { results } = await db
		.prepare(
			`SELECT n.name_key, p.id, p.title FROM page_names n
			 JOIN pages p ON p.id = n.page_id AND p.deleted_at IS NULL
			 WHERE n.name_key IN (SELECT value FROM json_each(?))`
		)
		.bind(JSON.stringify(keys))
		.all<{ name_key: string; id: string; title: string }>();
	return Object.fromEntries(results.map((r) => [r.name_key, { id: r.id, title: r.title }]));
}

export async function relatedPages(db: D1Database, pageId: string): Promise<RelatedDto> {
	const [links, backlinks, shared] = await db.batch<Record<string, unknown>>([
		db
			.prepare(
				`SELECT l.target_name_key AS name, p.id, p.title
				 FROM page_links l
				 LEFT JOIN page_names n ON n.name_key = l.target_name_key
				 LEFT JOIN pages p ON p.id = n.page_id AND p.deleted_at IS NULL
				 WHERE l.source_page_id = ?1 AND (p.id IS NULL OR p.id <> ?1)
				 LIMIT ${LIMITS.links}`
			)
			.bind(pageId),
		db
			.prepare(
				`SELECT DISTINCT p.id, p.title, p.updated_at
				 FROM page_links l JOIN pages p ON p.id = l.source_page_id AND p.deleted_at IS NULL
				 WHERE l.target_name_key IN (SELECT name_key FROM page_names WHERE page_id = ?1)
				   AND p.id <> ?1
				 ORDER BY p.updated_at DESC LIMIT ${LIMITS.backlinks}`
			)
			.bind(pageId),
		// Pages that link to the same targets (aliases merged per resolved page).
		db
			.prepare(
				`WITH t AS (
				   SELECT DISTINCT n.page_id AS pid, l.target_name_key AS name
				   FROM page_links l LEFT JOIN page_names n ON n.name_key = l.target_name_key
				   WHERE l.source_page_id = ?1
				 ),
				 g AS (
				   SELECT COALESCE(t.pid, 'name:' || t.name) AS grp, COALESCE(pn.name_key, t.name) AS name
				   FROM t LEFT JOIN page_names pn ON pn.page_id = t.pid
				 ),
				 hits AS (
				   SELECT g.grp, p.id, p.title, max(p.updated_at) AS updated_at
				   FROM g JOIN page_links l2 ON l2.target_name_key = g.name
				   JOIN pages p ON p.id = l2.source_page_id AND p.deleted_at IS NULL
				   WHERE p.id <> ?1 AND p.id <> g.grp AND g.grp <> ?1
				   GROUP BY g.grp, p.id
				 ),
				 ranked AS (
				   SELECT grp, id, title, updated_at,
				     ROW_NUMBER() OVER (PARTITION BY grp ORDER BY updated_at DESC) AS rn,
				     count(*) OVER (PARTITION BY grp) AS total,
				     max(updated_at) OVER (PARTITION BY grp) AS latest
				   FROM hits
				 )
				 SELECT grp, id, title, total, latest FROM ranked
				 WHERE rn <= ${LIMITS.sharedPerGroup}
				 ORDER BY latest DESC, grp, rn
				 LIMIT ${LIMITS.sharedGroups * LIMITS.sharedPerGroup * 4}`
			)
			.bind(pageId)
	]);

	const linkRows = links.results as { name: string; id: string | null; title: string | null }[];
	const targets = new Map<string, RelatedDto['links'][number]>();
	for (const r of linkRows) {
		const key = r.id ?? `name:${r.name}`;
		if (!targets.has(key)) {
			targets.set(key, { name: r.name, page: r.id ? { id: r.id, title: r.title! } : null });
		}
	}

	const groups = new Map<string, RelatedDto['shared'][number]>();
	for (const r of shared.results as { grp: string; id: string; title: string; total: number }[]) {
		if (!groups.has(r.grp)) {
			if (groups.size >= LIMITS.sharedGroups) continue;
			const target = targets.get(r.grp) ?? {
				name: r.grp.startsWith('name:') ? r.grp.slice(5) : r.grp,
				page: null
			};
			groups.set(r.grp, { target, pages: [], more: r.total > LIMITS.sharedPerGroup });
		}
		groups.get(r.grp)!.pages.push({ id: r.id, title: r.title });
	}

	return {
		links: [...targets.values()],
		backlinks: (backlinks.results as { id: string; title: string }[]).map((r) => ({
			id: r.id,
			title: r.title
		})),
		shared: [...groups.values()]
	};
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Title / alias suggestions for `[` and `#` completion: prefix matches first, then substring. */
export async function suggestTitles(
	db: D1Database,
	query: string,
	limit = 20
): Promise<TitleSuggestionDto[]> {
	const q = nameKey(query).slice(0, 200);
	const n = Math.min(Math.max(limit, 1), 50);
	const stmt = q
		? db
				.prepare(
					`SELECT n.display_name AS title, n.page_id, n.kind,
					   CASE WHEN n.name_key LIKE ?1 ESCAPE '\\' THEN 0 ELSE 1 END AS rank
					 FROM page_names n JOIN pages p ON p.id = n.page_id AND p.deleted_at IS NULL
					 WHERE n.name_key LIKE ?2 ESCAPE '\\'
					 ORDER BY rank, n.kind = 'alias', length(n.name_key), p.updated_at DESC
					 LIMIT ?3`
				)
				.bind(`${escapeLike(q)}%`, `%${escapeLike(q)}%`, n)
		: db
				.prepare(
					`SELECT n.display_name AS title, n.page_id, n.kind, 0 AS rank
					 FROM page_names n JOIN pages p ON p.id = n.page_id AND p.deleted_at IS NULL
					 WHERE n.kind = 'canonical' ORDER BY p.updated_at DESC LIMIT ?1`
				)
				.bind(n);
	const { results } = await stmt.all<{ title: string; page_id: string; kind: string }>();
	return results.map((r) => ({ title: r.title, pageId: r.page_id, alias: r.kind === 'alias' }));
}
