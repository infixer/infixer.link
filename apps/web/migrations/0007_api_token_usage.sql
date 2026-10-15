-- CLI tokens (Phase 7, ADR 0016): when a token was last used, refreshed at most hourly.
ALTER TABLE api_tokens ADD COLUMN last_used_at INTEGER;
CREATE INDEX api_tokens_active ON api_tokens (revoked_at, created_at);
