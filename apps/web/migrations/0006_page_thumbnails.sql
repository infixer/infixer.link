-- List cards (ADR 0014): thumbnail candidates of each page, in document order.
-- Entries are `asset:{id}` (an image) or `url:{url}` (a link card / video). The list shows
-- the first candidate whose image is ready; the image itself is resolved when reading,
-- because uploads and card images become ready after the page is saved.
-- Pages saved before this migration get candidates on their next save
-- (or with `pnpm --filter web db:backfill-thumbnails` locally).
ALTER TABLE pages ADD COLUMN thumbs_json TEXT NOT NULL DEFAULT '[]'
	CHECK (json_valid(thumbs_json) AND json_type(thumbs_json) = 'array');
