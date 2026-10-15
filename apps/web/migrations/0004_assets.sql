-- Images (design §10, ADR 0012). Bytes live in R2; this table tracks state and metadata.
-- Several asset ids may share one immutable object (same SHA-256), so object_key is not unique.
CREATE TABLE assets (
	id TEXT PRIMARY KEY,
	status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'rejected')),
	source TEXT NOT NULL CHECK (source IN ('upload', 'link-preview')),
	mime TEXT,
	bytes INTEGER,
	width INTEGER,
	height INTEGER,
	sha256 TEXT,
	object_key TEXT,
	original_name TEXT,
	error TEXT,
	created_at INTEGER NOT NULL,
	published_at INTEGER
);

CREATE INDEX assets_status ON assets (status, created_at);
CREATE INDEX assets_sha256 ON assets (sha256);

ALTER TABLE link_previews ADD COLUMN image_asset_id TEXT REFERENCES assets (id);
