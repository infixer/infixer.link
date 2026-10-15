/**
 * Search / list / related-page cost on synthetic 2,000 and 10,000-page databases
 * (design §11.1 item 6, §12.2, §17 Phase 5). Run with `pnpm --filter web perf:data`.
 *
 * Local workerd + local D1 (SQLite), not Cloudflare: timings are indicative only.
 * rows read / written come from D1 `meta` and are what D1 bills.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { extractReferences, nameKey, parse } from '@infixer-link/content';
import { resetDb } from '../helpers/api-client';
import { generatePages, MARKERS, type SyntheticPage } from '../../scripts/synthetic';
import { searchPages } from '../../src/lib/server/pages/search';
import { getPublicPage, listPages } from '../../src/lib/server/pages/service';
import { relatedPages, resolveNames, suggestTitles } from '../../src/lib/server/pages/graph';

const RUNS = 30;

interface Meter {
	rowsRead: number;
	rowsWritten: number;
	queries: number;
}

/** D1 wrapper that sums meta.rows_read / rows_written. `first()` is served via `all()`. */
function metered(db: D1Database, meter: Meter): D1Database {
	const add = (meta: D1Meta | undefined) => {
		meter.queries++;
		meter.rowsRead += meta?.rows_read ?? 0;
		meter.rowsWritten += meta?.rows_written ?? 0;
	};
	const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
		new Proxy(stmt, {
			get(target, prop) {
				if (prop === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
				if (prop === 'all' || prop === 'run')
					return async () => {
						const r = await target.all();
						add(r.meta);
						return r;
					};
				if (prop === 'first')
					return async (column?: string) => {
						const r = await target.all<Record<string, unknown>>();
						add(r.meta);
						const row = r.results[0] ?? null;
						return column && row ? row[column] : row;
					};
				return Reflect.get(target, prop, target);
			}
		});
	return new Proxy(db, {
		get(target, prop) {
			if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql));
			if (prop === 'batch')
				return async (stmts: D1PreparedStatement[]) => {
					const rs = await target.batch(stmts);
					for (const r of rs) add(r.meta);
					return rs;
				};
			return Reflect.get(target, prop, target);
		}
	});
}

async function insertAll(pages: SyntheticPage[]) {
	const stmt = env.DB.prepare(
		`INSERT INTO pages (id, title, title_key, source, format, revision, daily_date, created_at,
		   updated_at, last_mutation_id, request_hash, last_operation, links_json, assets_json)
		 VALUES (?, ?, ?, ?, 'link-text-v1', 1, ?, ?, ?, ?, 'synthetic', 'create', ?, '[]')`
	);
	const started = performance.now();
	let rowsWritten = 0;
	for (let i = 0; i < pages.length; i += 200) {
		const rs = await env.DB.batch(
			pages
				.slice(i, i + 200)
				.map((p) =>
					stmt.bind(
						p.id,
						p.title,
						nameKey(p.title),
						p.source,
						p.dailyDate,
						p.updatedAt,
						p.updatedAt,
						crypto.randomUUID(),
						JSON.stringify(extractReferences(p.source).links)
					)
				)
		);
		for (const r of rs) rowsWritten += r.meta.rows_written ?? 0;
	}
	return { ms: performance.now() - started, rowsWritten };
}

const pct = (sorted: number[], p: number) =>
	sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

async function measure<T>(
	label: string,
	run: (db: D1Database) => Promise<T>,
	size?: (r: T) => number
) {
	const times: number[] = [];
	let meter: Meter = { rowsRead: 0, rowsWritten: 0, queries: 0 };
	let result!: T;
	await run(env.DB); // warm-up
	for (let i = 0; i < RUNS; i++) {
		meter = { rowsRead: 0, rowsWritten: 0, queries: 0 };
		const t = performance.now();
		result = await run(metered(env.DB, meter));
		times.push(performance.now() - t);
	}
	times.sort((a, b) => a - b);
	return {
		label,
		p50: pct(times, 50),
		p95: pct(times, 95),
		rowsRead: meter.rowsRead,
		queries: meter.queries,
		results: size ? size(result) : null
	};
}

type Row = Awaited<ReturnType<typeof measure>>;

function report(title: string, rows: Row[]) {
	const lines = [
		`\n### ${title}`,
		'| 対象 | p50 ms | p95 ms | rows read | queries | 件数 |',
		'|---|---|---|---|---|---|',
		...rows.map(
			(r) =>
				`| ${r.label} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.rowsRead} | ${r.queries} | ${r.results ?? '—'} |`
		)
	];
	console.log(lines.join('\n'));
}

const searchQueries: [string, string][] = [
	['1 文字（LIKE）', '本'],
	['2 文字（LIKE）', MARKERS.hub],
	['3 文字（FTS）', 'オイデ'],
	['固有の長い語（FTS、約 0.5%）', MARKERS.rare],
	['1 件だけの語（FTS）', MARKERS.unique],
	['英字・大小無視（FTS）', MARKERS.latin.toLowerCase()],
	['英数 2 文字（LIKE）', 'd1'],
	['複数語（FTS + LIKE）', `${MARKERS.latin} 設定`],
	['ヒットなし（FTS）', 'ぬるぽガッ'],
	['ヒットなし（LIKE）', '鬱'],
	['日付の前方一致（名前）', '2021-03']
];

describe.each([2_000, 10_000])('%i synthetic pages', (count) => {
	it('measures insert, search, list, page load and related pages', async () => {
		await resetDb();
		const pages = generatePages(count);
		const insert = await insertAll(pages);
		const chars = pages.reduce((n, p) => n + p.source.length, 0);
		console.log(
			`\n## ${count} pages: ${(chars / count).toFixed(0)} chars/page avg, ` +
				`insert ${(insert.ms / 1000).toFixed(1)}s, rows written ${insert.rowsWritten} ` +
				`(${(insert.rowsWritten / count).toFixed(1)}/page)`
		);

		const search: Row[] = [];
		for (const [label, q] of searchQueries) {
			search.push(
				await measure(
					label,
					(db) => searchPages(db, q),
					(r) => r.hits.length
				)
			);
		}
		report(`検索（${count} ページ、上位 20 件）`, search);

		// Correctness on the synthetic data: the unique marker is found exactly once.
		expect((await searchPages(env.DB, MARKERS.unique)).hits).toHaveLength(1);

		const hubPage = pages.find((p) => p.source.includes(`#${MARKERS.hub}`))!;
		const longPage = pages.reduce((a, b) => (b.source.length > a.source.length ? b : a));
		const firstPage = await listPages(env.DB);
		let cursor = firstPage.nextCursor!;
		for (let i = 0; i < 20; i++) cursor = (await listPages(env.DB, { cursor })).nextCursor!;

		const pageLoad = (id: string) => async (db: D1Database) => {
			const page = (await getPublicPage(db, id))!;
			const parsed = parse(page.source);
			const [names, related] = await Promise.all([
				resolveNames(db, parsed.links),
				relatedPages(db, page.id)
			]);
			return { page, names, related };
		};

		const other: Row[] = [
			await measure(
				'一覧の先頭 30 件',
				(db) => listPages(db),
				(r) => r.pages.length
			),
			await measure(
				'一覧の 21 ページ目（カーソル）',
				(db) => listPages(db, { cursor }),
				(r) => r.pages.length
			),
			await measure(
				`関連ページ（#${MARKERS.hub} を含むページ。接続集中）`,
				(db) => relatedPages(db, hubPage.id),
				(r) => r.shared.reduce((n, g) => n + g.pages.length, 0)
			),
			await measure(`公開ページの load 相当（#${MARKERS.hub} を含むページ）`, pageLoad(hubPage.id)),
			await measure(
				`公開ページの load 相当（最長 ${longPage.source.length} 文字）`,
				pageLoad(longPage.id)
			),
			await measure(
				'補完（2 文字）',
				(db) => suggestTitles(db, 'リン'),
				(r) => r.length
			)
		];
		report(`一覧・ページ・関連（${count} ページ）`, other);

		// Write cost of one edit (ADR 0002 risk): FTS re-index + history row.
		for (const [label, page] of [
			['通常のページ', pages[count - 1]!],
			[`最長のページ（${longPage.source.length} 文字）`, longPage]
		] as const) {
			const r = await env.DB.prepare(
				`UPDATE pages SET source = source || ?, revision = revision + 1, updated_at = updated_at + 1,
				   last_mutation_id = ?, last_operation = 'update' WHERE id = ? RETURNING revision`
			)
				.bind('\n追記', crypto.randomUUID(), page.id)
				.all();
			console.log(
				`更新 1 回（${label}）：rows written ${r.meta.rows_written}, rows read ${r.meta.rows_read}`
			);
		}
	});
});
