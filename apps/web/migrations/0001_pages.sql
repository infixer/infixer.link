-- Pages, names, revisions, links, change feed and search index (design §7, ADR 0002).
-- Derived rows are maintained by triggers so that a single conditional
-- INSERT/UPDATE on `pages` is atomic with all of them.

CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES ('time_zone', 'Asia/Tokyo');

CREATE TABLE pages (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	title_key TEXT NOT NULL,
	source TEXT NOT NULL,
	format TEXT NOT NULL CHECK (format = 'link-text-v1'),
	revision INTEGER NOT NULL CHECK (revision >= 1),
	daily_date TEXT UNIQUE CHECK (daily_date IS NULL OR daily_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	deleted_at INTEGER,
	last_mutation_id TEXT NOT NULL,
	request_hash TEXT NOT NULL,
	last_operation TEXT NOT NULL CHECK (last_operation IN ('create', 'update', 'delete', 'restore')),
	links_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(links_json) AND json_type(links_json) = 'array'),
	assets_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(assets_json) AND json_type(assets_json) = 'array')
);

CREATE INDEX pages_updated ON pages (updated_at DESC, id DESC) WHERE deleted_at IS NULL;

CREATE TABLE page_names (
	name_key TEXT PRIMARY KEY,
	page_id TEXT NOT NULL REFERENCES pages (id),
	display_name TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('canonical', 'alias'))
);

CREATE INDEX page_names_page ON page_names (page_id);

CREATE TABLE page_revisions (
	page_id TEXT NOT NULL REFERENCES pages (id),
	revision INTEGER NOT NULL,
	mutation_id TEXT NOT NULL UNIQUE,
	request_hash TEXT NOT NULL,
	operation TEXT NOT NULL,
	title TEXT NOT NULL,
	format TEXT NOT NULL,
	source TEXT NOT NULL,
	deleted_at INTEGER,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (page_id, revision)
);

CREATE TABLE page_links (
	source_page_id TEXT NOT NULL REFERENCES pages (id),
	target_name_key TEXT NOT NULL,
	PRIMARY KEY (source_page_id, target_name_key)
);

CREATE INDEX page_links_target ON page_links (target_name_key, source_page_id);

CREATE TABLE page_assets (
	page_id TEXT NOT NULL REFERENCES pages (id),
	asset_id TEXT NOT NULL,
	PRIMARY KEY (page_id, asset_id)
);

CREATE INDEX page_assets_asset ON page_assets (asset_id, page_id);

CREATE TABLE changes (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	page_id TEXT NOT NULL,
	revision INTEGER NOT NULL,
	operation TEXT NOT NULL,
	UNIQUE (page_id, revision)
);

CREATE VIRTUAL TABLE pages_fts USING fts5 (page_id UNINDEXED, title, source, tokenize = 'trigram');

-- Create: history, change feed, canonical name, links, assets, search.
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

	INSERT INTO pages_fts (page_id, title, source)
	SELECT NEW.id, NEW.title, NEW.source WHERE NEW.deleted_at IS NULL;
END;

-- Every new revision: history, change feed, search index.
CREATE TRIGGER pages_after_revision AFTER UPDATE OF revision ON pages
WHEN NEW.revision <> OLD.revision
BEGIN
	INSERT INTO page_revisions (page_id, revision, mutation_id, request_hash, operation, title, format, source, deleted_at, created_at)
	VALUES (NEW.id, NEW.revision, NEW.last_mutation_id, NEW.request_hash, NEW.last_operation, NEW.title, NEW.format, NEW.source, NEW.deleted_at, NEW.updated_at);

	INSERT INTO changes (page_id, revision, operation) VALUES (NEW.id, NEW.revision, NEW.last_operation);

	DELETE FROM pages_fts WHERE page_id = NEW.id;

	INSERT INTO pages_fts (page_id, title, source)
	SELECT NEW.id, NEW.title, NEW.source WHERE NEW.deleted_at IS NULL;
END;

-- Rename: old name becomes an alias; the new name must be free or already ours.
CREATE TRIGGER pages_after_rename AFTER UPDATE OF title_key ON pages
WHEN NEW.title_key <> OLD.title_key
BEGIN
	UPDATE page_names SET kind = 'alias' WHERE page_id = NEW.id AND kind = 'canonical';

	INSERT INTO page_names (name_key, page_id, display_name, kind) VALUES (NEW.title_key, NEW.id, NEW.title, 'canonical')
	ON CONFLICT (name_key) DO UPDATE SET kind = 'canonical', display_name = excluded.display_name
	WHERE page_names.page_id = excluded.page_id;

	SELECT RAISE (ABORT, 'name_conflict')
	WHERE (SELECT page_id FROM page_names WHERE name_key = NEW.title_key) <> NEW.id;
END;

-- Same name, different display form (e.g. NFC-equal input): keep display_name current.
CREATE TRIGGER pages_after_title_display AFTER UPDATE OF title ON pages
WHEN NEW.title <> OLD.title AND NEW.title_key = OLD.title_key
BEGIN
	UPDATE page_names SET display_name = NEW.title WHERE name_key = NEW.title_key;
END;

-- Only rewrite link / asset rows when the extracted set actually changed.
CREATE TRIGGER pages_after_links AFTER UPDATE OF links_json ON pages
WHEN NEW.links_json IS NOT OLD.links_json
BEGIN
	DELETE FROM page_links WHERE source_page_id = NEW.id;

	INSERT INTO page_links (source_page_id, target_name_key)
	SELECT DISTINCT NEW.id, value FROM json_each (NEW.links_json);
END;

CREATE TRIGGER pages_after_assets AFTER UPDATE OF assets_json ON pages
WHEN NEW.assets_json IS NOT OLD.assets_json
BEGIN
	DELETE FROM page_assets WHERE page_id = NEW.id;

	INSERT INTO page_assets (page_id, asset_id)
	SELECT DISTINCT NEW.id, value FROM json_each (NEW.assets_json);
END;
