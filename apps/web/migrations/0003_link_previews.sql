-- Link card metadata (ADR 0010). Fetched only on owner request; public pages read this cache.
CREATE TABLE link_previews (
	url TEXT PRIMARY KEY CHECK (length(url) <= 2048),
	status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
	title TEXT,
	description TEXT,
	site_name TEXT,
	-- Stored for Phase 4 (copied into R2 before display); never hotlinked.
	image_url TEXT,
	final_url TEXT,
	fetched_at INTEGER NOT NULL
);
