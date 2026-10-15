/**
 * Japanese full-text search (design §11.1, ADR 0013).
 *
 * - Names first: exact title / alias, then prefix, then substring (all terms in one name).
 * - Body: FTS5 trigram for terms of 3+ code points; trigram cannot match 1–2 characters, so
 *   short terms use an escaped LIKE over title and source. Terms are ANDed.
 * - The FTS query syntax is never exposed: every term becomes a quoted phrase.
 * - Bounded: query length, number of terms, page size and offset depth.
 */
import type { SearchDto, SearchHitDto, SearchMatch } from '@infixer-link/contracts';
import { LIMITS } from '@infixer-link/contracts';
import { nameKey } from '@infixer-link/content';
import { toIso } from '../http';

/** Trigram needs three characters; shorter terms fall back to LIKE. */
const TRIGRAM = 3;
const EXCERPT_BEFORE = 30;
const EXCERPT_LENGTH = 110;

const codePoints = (s: string) => [...s].length;
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
/** SQLite lower() and LIKE fold ASCII only; do the same so offsets agree. */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const ftsPhrase = (term: string) => `"${term.replaceAll('"', '""')}"`;

export interface ParsedQuery {
	/** Whitespace-normalized query ('' when there is nothing to search). */
	text: string;
	terms: string[];
}

/** NFC, collapse whitespace (including U+3000), cap length and number of terms. */
export function parseQuery(raw: string): ParsedQuery {
	const capped = [...raw.normalize('NFC').replace(/\s+/gu, ' ').trim()]
		.slice(0, LIMITS.searchQueryCodePoints)
		.join('')
		.trim();
	const terms = [...new Set(capped.split(' ').filter(Boolean))].slice(0, LIMITS.searchTerms);
	return { text: terms.join(' '), terms };
}

/** Splits an excerpt into plain / highlighted parts (ASCII case-insensitive, like LIKE). */
export function highlight(text: string, terms: string[]): SearchHitDto['excerpt'] {
	const lower = asciiLower(text);
	const marks: [number, number][] = [];
	for (const term of terms.map(asciiLower)) {
		for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + term.length)) {
			marks.push([at, at + term.length]);
		}
	}
	marks.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	const parts: SearchHitDto['excerpt'] = [];
	let pos = 0;
	for (const [start, end] of marks) {
		if (end <= pos) continue;
		const from = Math.max(start, pos);
		const last = parts.at(-1);
		if (from > pos) parts.push({ text: text.slice(pos, from), hit: false });
		else if (last?.hit) {
			// Touching or overlapping matches become one highlight.
			last.text += text.slice(from, end);
			pos = end;
			continue;
		}
		parts.push({ text: text.slice(from, end), hit: true });
		pos = end;
	}
	if (pos < text.length) parts.push({ text: text.slice(pos), hit: false });
	return parts;
}

interface Row {
	id: string;
	title: string;
	daily_date: string | null;
	updated_at: number;
	score: number;
	alias: string | null;
	excerpt: string;
	excerpt_start: number;
	source_length: number;
}

export async function searchPages(
	db: D1Database,
	rawQuery: string,
	options: { limit?: number; offset?: number } = {}
): Promise<SearchDto> {
	const { text, terms } = parseQuery(rawQuery);
	if (terms.length === 0) return { query: '', hits: [], nextOffset: null };
	const limit = Math.min(Math.max(options.limit ?? LIMITS.searchDefault, 1), LIMITS.searchMax);
	const offset = Math.min(Math.max(options.offset ?? 0, 0), LIMITS.searchMaxOffset);

	const params: unknown[] = [];
	const p = (value: unknown) => {
		params.push(value);
		return `?${params.length}`;
	};
	const contains = (column: string, term: string) =>
		`${column} LIKE ${p(`%${escapeLike(term)}%`)} ESCAPE '\\'`;

	const long = terms.filter((t) => codePoints(t) >= TRIGRAM);
	const short = terms.filter((t) => codePoints(t) < TRIGRAM);
	const key = nameKey(text);

	// score = tier * 2 + (alias ? 1 : 0); tiers: 0 exact name, 1 name prefix, 2 title contains
	// every term, 3 body only. Names use the name_key index (exact / prefix range, aliases
	// included); a LIKE '%…%' over every name would read every row on each search.
	const nameHits = `SELECT page_id, min((name_key <> ${p(key)}) * 2 + (kind = 'alias')) AS score,
		  display_name AS alias
		FROM page_names WHERE name_key >= ${p(key)} AND name_key < ${p(key)} || char(1114111)
		GROUP BY page_id`;

	const anyColumn = (t: string, table = '') =>
		`(${contains(`${table}title`, t)} OR ${contains(`${table}source`, t)})`;
	const bodyHits =
		long.length > 0
			? `SELECT f.page_id FROM pages_fts f JOIN pages b ON b.id = f.page_id
			   WHERE pages_fts MATCH ${p(long.map(ftsPhrase).join(' AND '))}
			   ${short.map((t) => `AND ${anyColumn(t, 'b.')}`).join(' ')}`
			: `SELECT id AS page_id FROM pages
			   WHERE deleted_at IS NULL AND ${terms.map((t) => anyColumn(t)).join(' AND ')}`;

	// Excerpt: around the first occurrence of any term in the body (ASCII case-insensitive).
	const firstAt = `coalesce(${terms
		.map((t) => `nullif(instr(lower(p.source), ${p(asciiLower(t))}), 0)`)
		.join(', ')}, 1)`;
	const excerptStart = `max(1, ${firstAt} - ${EXCERPT_BEFORE})`;
	const titleHasAll = terms
		.map((t) => `instr(lower(p.title), ${p(asciiLower(t))}) > 0`)
		.join(' AND ');

	const sql = `WITH
		names AS (${nameHits}),
		body AS (${bodyHits}),
		hits AS (
		  SELECT page_id, min(score) AS score, alias FROM (
		    SELECT page_id, score, alias FROM names
		    UNION ALL SELECT page_id, 6, NULL FROM body
		  ) GROUP BY page_id
		)
		SELECT p.id, p.title, p.daily_date, p.updated_at,
		  min(h.score, CASE WHEN ${titleHasAll} THEN 4 ELSE 6 END) AS score, h.alias,
		  substr(p.source, ${excerptStart}, ${EXCERPT_LENGTH}) AS excerpt,
		  ${excerptStart} AS excerpt_start, length(p.source) AS source_length
		FROM hits h JOIN pages p ON p.id = h.page_id AND p.deleted_at IS NULL
		ORDER BY score, p.updated_at DESC, p.id DESC
		LIMIT ${p(limit + 1)} OFFSET ${p(offset)}`;

	const { results } = await db
		.prepare(sql)
		.bind(...params)
		.all<Row>();

	const hits = results.slice(0, limit).map((r): SearchHitDto => {
		const match: SearchMatch = r.score >= 6 ? 'body' : r.score % 2 === 1 ? 'alias' : 'title';
		let excerpt = r.excerpt.replace(/\s+/gu, ' ').trim();
		if (excerpt && r.excerpt_start > 1) excerpt = `…${excerpt}`;
		if (excerpt && r.excerpt_start - 1 + EXCERPT_LENGTH < r.source_length) excerpt = `${excerpt}…`;
		return {
			id: r.id,
			title: r.title,
			dailyDate: r.daily_date,
			updatedAt: toIso(r.updated_at),
			match,
			alias: match === 'alias' ? r.alias : null,
			excerpt: highlight(excerpt, terms)
		};
	});
	const more = results.length > limit && offset + limit <= LIMITS.searchMaxOffset;
	return { query: text, hits, nextOffset: more ? offset + limit : null };
}
