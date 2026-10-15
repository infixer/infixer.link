/**
 * Phase 0 capability proof for design §7.3 / §11.1 on D1 (local workerd/SQLite):
 * - AFTER triggers + json_each maintain history, changes, links, names and FTS
 *   atomically with a single conditional UPDATE.
 * - A 0-row conditional UPDATE leaves derived data untouched.
 * - A constraint failure inside a trigger rolls back the whole statement.
 * - FTS5 trigram tokenizer works for Japanese substrings (>= 3 chars).
 *
 * This is a throwaway prototype schema, not the Phase 1 migration.
 */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

const db = env.DB;

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS pages (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		source TEXT NOT NULL,
		revision INTEGER NOT NULL CHECK (revision >= 1),
		last_mutation_id TEXT NOT NULL,
		links_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(links_json)),
		deleted_at INTEGER,
		updated_at INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS page_names (
		name_key TEXT PRIMARY KEY,
		page_id TEXT NOT NULL REFERENCES pages(id),
		kind TEXT NOT NULL CHECK (kind IN ('canonical', 'alias'))
	)`,
	`CREATE TABLE IF NOT EXISTS page_revisions (
		page_id TEXT NOT NULL REFERENCES pages(id),
		revision INTEGER NOT NULL,
		mutation_id TEXT NOT NULL UNIQUE,
		title TEXT NOT NULL,
		source TEXT NOT NULL,
		PRIMARY KEY (page_id, revision)
	)`,
	`CREATE TABLE IF NOT EXISTS page_links (
		source_page_id TEXT NOT NULL REFERENCES pages(id),
		target_name_key TEXT NOT NULL,
		PRIMARY KEY (source_page_id, target_name_key)
	)`,
	`CREATE TABLE IF NOT EXISTS changes (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		page_id TEXT NOT NULL,
		revision INTEGER NOT NULL
	)`,
	`CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
		page_id UNINDEXED, title, source, tokenize = 'trigram'
	)`,
	`CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
		INSERT INTO page_revisions (page_id, revision, mutation_id, title, source)
			VALUES (NEW.id, NEW.revision, NEW.last_mutation_id, NEW.title, NEW.source);
		INSERT INTO changes (page_id, revision) VALUES (NEW.id, NEW.revision);
		INSERT INTO page_names (name_key, page_id, kind) VALUES (NEW.title, NEW.id, 'canonical');
		INSERT INTO page_links (source_page_id, target_name_key)
			SELECT NEW.id, value FROM json_each(NEW.links_json);
		INSERT INTO pages_fts (page_id, title, source) VALUES (NEW.id, NEW.title, NEW.source);
	END`,
	`CREATE TRIGGER IF NOT EXISTS pages_au_revision AFTER UPDATE ON pages
	WHEN NEW.revision <> OLD.revision BEGIN
		INSERT INTO page_revisions (page_id, revision, mutation_id, title, source)
			VALUES (NEW.id, NEW.revision, NEW.last_mutation_id, NEW.title, NEW.source);
		INSERT INTO changes (page_id, revision) VALUES (NEW.id, NEW.revision);
		DELETE FROM pages_fts WHERE page_id = NEW.id;
		INSERT INTO pages_fts (page_id, title, source) VALUES (NEW.id, NEW.title, NEW.source);
	END`,
	`CREATE TRIGGER IF NOT EXISTS pages_au_title AFTER UPDATE OF title ON pages
	WHEN NEW.title <> OLD.title BEGIN
		UPDATE page_names SET kind = 'alias' WHERE page_id = NEW.id AND kind = 'canonical';
		INSERT INTO page_names (name_key, page_id, kind) VALUES (NEW.title, NEW.id, 'canonical')
			ON CONFLICT (name_key) DO UPDATE SET kind = 'canonical' WHERE page_id = NEW.id;
		SELECT RAISE(ABORT, 'name_conflict')
			WHERE (SELECT page_id FROM page_names WHERE name_key = NEW.title) <> NEW.id;
	END`,
	`CREATE TRIGGER IF NOT EXISTS pages_au_links AFTER UPDATE OF links_json ON pages
	WHEN NEW.links_json IS NOT OLD.links_json BEGIN
		DELETE FROM page_links WHERE source_page_id = NEW.id;
		INSERT INTO page_links (source_page_id, target_name_key)
			SELECT NEW.id, value FROM json_each(NEW.links_json);
	END`
];

const RESET = ['pages_fts', 'changes', 'page_links', 'page_revisions', 'page_names', 'pages'].map(
	(t) => `DELETE FROM ${t}`
);

beforeEach(async () => {
	await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
	await db.batch(RESET.map((sql) => db.prepare(sql)));
});

async function createPage(id: string, title: string, source: string, links: string[]) {
	await db
		.prepare(
			`INSERT INTO pages (id, title, source, revision, last_mutation_id, links_json, updated_at)
			 VALUES (?, ?, ?, 1, ?, ?, ?)`
		)
		.bind(id, title, source, crypto.randomUUID(), JSON.stringify(links), Date.now())
		.run();
}

function updatePage(
	id: string,
	baseRevision: number,
	fields: { title: string; source: string; links: string[]; mutationId?: string }
) {
	return db
		.prepare(
			`UPDATE pages SET title = ?, source = ?, links_json = ?, revision = revision + 1,
			   last_mutation_id = ?, updated_at = ?
			 WHERE id = ? AND revision = ? AND deleted_at IS NULL
			 RETURNING revision`
		)
		.bind(
			fields.title,
			fields.source,
			JSON.stringify(fields.links),
			fields.mutationId ?? crypto.randomUUID(),
			Date.now(),
			id,
			baseRevision
		)
		.all<{ revision: number }>();
}

async function snapshot(id: string) {
	const [page, revisions, links, names, changes, fts] = await db.batch<Record<string, unknown>>([
		db.prepare('SELECT title, source, revision FROM pages WHERE id = ?').bind(id),
		db.prepare('SELECT revision FROM page_revisions WHERE page_id = ? ORDER BY revision').bind(id),
		db
			.prepare('SELECT rowid, target_name_key FROM page_links WHERE source_page_id = ? ORDER BY 2')
			.bind(id),
		db.prepare('SELECT name_key, kind FROM page_names WHERE page_id = ? ORDER BY 1').bind(id),
		db.prepare('SELECT revision FROM changes WHERE page_id = ? ORDER BY seq').bind(id),
		db.prepare('SELECT title, source FROM pages_fts WHERE page_id = ?').bind(id)
	]);
	return {
		page: page.results[0],
		revisions: revisions.results.map((r) => r.revision),
		links: links.results,
		names: names.results,
		changes: changes.results.map((r) => r.revision),
		fts: fts.results
	};
}

describe('D1 triggers + json_each', () => {
	it('derives history, changes, names, links and FTS on insert', async () => {
		await createPage('p1', '2026-10-15', '今日のメモ [読書]', ['読書', 'アンチ・オイディプス']);
		const s = await snapshot('p1');
		expect(s.revisions).toEqual([1]);
		expect(s.changes).toEqual([1]);
		expect(s.names).toEqual([{ name_key: '2026-10-15', kind: 'canonical' }]);
		expect(s.links.map((l) => l.target_name_key)).toEqual(['アンチ・オイディプス', '読書']);
		expect(s.fts).toHaveLength(1);
	});

	it('conditional UPDATE advances revision and replaces derived rows atomically', async () => {
		await createPage('p1', 'メモ', 'a', ['A']);
		const result = await updatePage('p1', 1, { title: 'メモ', source: 'b', links: ['B'] });
		// Success must be judged by RETURNING rows: meta.changes also counts rows
		// written by triggers (history, links, FTS ...), so it is > 1 here.
		expect(result.results).toEqual([{ revision: 2 }]);
		expect(result.meta.changes).toBeGreaterThan(1);
		const s = await snapshot('p1');
		expect(s.page).toMatchObject({ source: 'b', revision: 2 });
		expect(s.revisions).toEqual([1, 2]);
		expect(s.changes).toEqual([1, 2]);
		expect(s.links.map((l) => l.target_name_key)).toEqual(['B']);
		expect(s.fts).toEqual([{ title: 'メモ', source: 'b' }]);
	});

	it('does not rewrite links when the link set is unchanged', async () => {
		await createPage('p1', 'メモ', 'a', ['A', 'B']);
		const before = await snapshot('p1');
		await updatePage('p1', 1, { title: 'メモ', source: 'a2', links: ['A', 'B'] });
		const after = await snapshot('p1');
		expect(after.links).toEqual(before.links); // same rowids => no delete/reinsert
	});

	it('stale baseRevision updates 0 rows and leaves derived data untouched', async () => {
		await createPage('p1', 'メモ', 'a', ['A']);
		await updatePage('p1', 1, { title: 'メモ', source: 'b', links: ['B'] });
		const before = await snapshot('p1');
		const stale = await updatePage('p1', 1, { title: 'メモ', source: 'c', links: ['C'] });
		expect(stale.results).toEqual([]);
		expect(stale.meta.changes).toBe(0);
		expect(await snapshot('p1')).toEqual(before);
	});

	it('rolls back page and derived rows when a rename collides inside a trigger', async () => {
		await createPage('p1', '読書', 'x', []);
		await createPage('p2', '日記', 'y', ['X']);
		const before = await snapshot('p2');
		await expect(updatePage('p2', 1, { title: '読書', source: 'z', links: ['Z'] })).rejects.toThrow(
			/name_conflict/
		);
		expect(await snapshot('p2')).toEqual(before);
	});

	it('keeps the old title as an alias after rename', async () => {
		await createPage('p1', '旧名', 'x', []);
		await updatePage('p1', 1, { title: '新名', source: 'x', links: [] });
		expect((await snapshot('p1')).names).toEqual([
			{ name_key: '新名', kind: 'canonical' },
			{ name_key: '旧名', kind: 'alias' }
		]);
	});

	it('rejects a reused mutation id and rolls back the update', async () => {
		await createPage('p1', 'メモ', 'a', []);
		const mutationId = crypto.randomUUID();
		await updatePage('p1', 1, { title: 'メモ', source: 'b', links: [], mutationId });
		const before = await snapshot('p1');
		await expect(
			updatePage('p1', 2, { title: 'メモ', source: 'c', links: [], mutationId })
		).rejects.toThrow(/UNIQUE/);
		expect(await snapshot('p1')).toEqual(before);
	});

	it('rolls back an entire D1 batch when a later statement fails', async () => {
		await createPage('p1', 'メモ', 'a', []);
		await expect(
			db.batch([
				db.prepare(`UPDATE pages SET source = 'changed' WHERE id = 'p1'`),
				db.prepare(
					`INSERT INTO page_names (name_key, page_id, kind) VALUES ('メモ', 'p1', 'canonical')`
				)
			])
		).rejects.toThrow();
		expect((await snapshot('p1')).page).toMatchObject({ source: 'a' });
	});
});

describe('FTS5 trigram for Japanese', () => {
	beforeEach(async () => {
		await createPage('p1', '読書メモ', 'アンチ・オイディプスの続きを読んだ', []);
		await createPage('p2', 'Cloudflare', 'D1とR2の構成メモ', []);
	});

	const search = async (q: string) =>
		(
			await db
				.prepare('SELECT page_id FROM pages_fts WHERE pages_fts MATCH ? ORDER BY page_id')
				.bind(`"${q.replaceAll('"', '""')}"`)
				.all()
		).results.map((r) => r.page_id);

	it('matches Japanese substrings of 3+ characters', async () => {
		expect(await search('オイディ')).toEqual(['p1']);
		expect(await search('読んだ')).toEqual(['p1']);
	});

	it('matches mixed Japanese / ASCII and is case-insensitive for ASCII', async () => {
		expect(await search('d1と')).toEqual(['p2']);
		expect(await search('cloudflare')).toEqual(['p2']);
	});

	it('does not match 1–2 character queries (LIKE fallback required, design §11.1)', async () => {
		expect(await search('読書')).toEqual([]);
	});

	it('reflects updates in the index', async () => {
		await updatePage('p1', 1, { title: '読書メモ', source: '別の本を読み始めた', links: [] });
		expect(await search('オイディ')).toEqual([]);
		expect(await search('読み始')).toEqual(['p1']);
	});
});
