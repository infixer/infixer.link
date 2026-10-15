-- Search index maintenance without full scans (design §11.1, ADR 0013).
--
-- 0001 removed a page's FTS row with `DELETE FROM pages_fts WHERE page_id = ?`. page_id is
-- UNINDEXED, so every save read every FTS row (10,006 rows read per save at 10,000 pages).
-- FTS rows now use a stable integer rowid per page, so delete/insert is a rowid lookup.
-- (pages.rowid is not used: without INTEGER PRIMARY KEY it may change on VACUUM.)

CREATE TABLE pages_fts_rowids (
	fts_rowid INTEGER PRIMARY KEY,
	page_id TEXT NOT NULL UNIQUE REFERENCES pages (id)
);

INSERT INTO pages_fts_rowids (page_id) SELECT id FROM pages ORDER BY created_at, id;

DELETE FROM pages_fts;

INSERT INTO pages_fts (rowid, page_id, title, source)
SELECT r.fts_rowid, p.id, p.title, p.source
FROM pages p JOIN pages_fts_rowids r ON r.page_id = p.id
WHERE p.deleted_at IS NULL;

-- Same bodies as 0001 except for the search index statements.
DROP TRIGGER pages_after_insert;
DROP TRIGGER pages_after_revision;

CREATE TRIGGER pages_after_insert AFTER INSERT ON pages
BEGIN
	SELECT RAISE (ABORT, 'name_conflict')
	WHERE EXISTS (SELECT 1 FROM page_names WHERE name_key = NEW.title_key);

	INSERT INTO page_revisions (page_id, revision, mutation_id, request_hash, operation, title, format, source, deleted_at, created_at)
	VALUES (NEW.id, NEW.revision, NEW.last_mutation_id, NEW.request_hash, NEW.last_operation, NEW.title, NEW.format, NEW.source, NEW.deleted_at, NEW.updated_at);

	INSERT INTO changes (page_id, revision, operation) VALUES (NEW.id, NEW.revision, NEW.last_operation);

	INSERT INTO page_names (name_key, page_id, display_name, kind) VALUES (NEW.title_key, NEW.id, NEW.title, 'canonical');

	INSERT INTO page_links (source_page_id, target_name_key)
	SELECT DISTINCT NEW.id, value FROM json_each (NEW.links_json);

	INSERT INTO page_assets (page_id, asset_id)
	SELECT DISTINCT NEW.id, value FROM json_each (NEW.assets_json);

	INSERT INTO pages_fts_rowids (page_id) VALUES (NEW.id);

	INSERT INTO pages_fts (rowid, page_id, title, source)
	SELECT r.fts_rowid, NEW.id, NEW.title, NEW.source
	FROM pages_fts_rowids r WHERE r.page_id = NEW.id AND NEW.deleted_at IS NULL;
END;

CREATE TRIGGER pages_after_revision AFTER UPDATE OF revision ON pages
WHEN NEW.revision <> OLD.revision
BEGIN
	INSERT INTO page_revisions (page_id, revision, mutation_id, request_hash, operation, title, format, source, deleted_at, created_at)
	VALUES (NEW.id, NEW.revision, NEW.last_mutation_id, NEW.request_hash, NEW.last_operation, NEW.title, NEW.format, NEW.source, NEW.deleted_at, NEW.updated_at);

	INSERT INTO changes (page_id, revision, operation) VALUES (NEW.id, NEW.revision, NEW.last_operation);

	DELETE FROM pages_fts
	WHERE rowid = (SELECT fts_rowid FROM pages_fts_rowids WHERE page_id = NEW.id);

	INSERT INTO pages_fts (rowid, page_id, title, source)
	SELECT r.fts_rowid, NEW.id, NEW.title, NEW.source
	FROM pages_fts_rowids r WHERE r.page_id = NEW.id AND NEW.deleted_at IS NULL;
END;
