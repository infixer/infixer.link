-- Single-owner passkey authentication (design §9.7).
-- Never exposed through public DTOs or exports.

CREATE TABLE owner (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	user_handle TEXT NOT NULL UNIQUE,
	setup_completed_at INTEGER,
	created_at INTEGER NOT NULL
);

CREATE TABLE passkeys (
	credential_id TEXT PRIMARY KEY,
	owner_id INTEGER NOT NULL REFERENCES owner (id),
	public_key BLOB NOT NULL,
	counter INTEGER NOT NULL DEFAULT 0,
	transports TEXT NOT NULL DEFAULT '[]',
	device_type TEXT NOT NULL,
	backed_up INTEGER NOT NULL,
	name TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER,
	revoked_at INTEGER
);

CREATE TABLE setup_grants (
	id TEXT PRIMARY KEY,
	token_hash TEXT NOT NULL UNIQUE,
	purpose TEXT NOT NULL CHECK (purpose IN ('setup', 'recovery')),
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	consumed_at INTEGER
);

CREATE TABLE auth_challenges (
	id TEXT PRIMARY KEY,
	challenge TEXT NOT NULL,
	browser_binding_hash TEXT NOT NULL,
	purpose TEXT NOT NULL CHECK (purpose IN ('login', 'reauth', 'register', 'setup', 'recovery')),
	owner_id INTEGER NOT NULL REFERENCES owner (id),
	session_id TEXT,
	grant_id TEXT REFERENCES setup_grants (id),
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	consumed_at INTEGER
);

CREATE INDEX auth_challenges_expires ON auth_challenges (expires_at);

CREATE TABLE sessions (
	id TEXT PRIMARY KEY,
	token_hash TEXT NOT NULL UNIQUE,
	owner_id INTEGER NOT NULL REFERENCES owner (id),
	credential_id TEXT NOT NULL,
	csrf_token TEXT NOT NULL,
	user_agent TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL,
	idle_expires_at INTEGER NOT NULL,
	absolute_expires_at INTEGER NOT NULL,
	reauthenticated_at INTEGER NOT NULL,
	revoked_at INTEGER
);

CREATE INDEX sessions_credential ON sessions (credential_id);

-- Phase 7 issues CLI tokens; the table exists now so that recovery can revoke them.
CREATE TABLE api_tokens (
	id TEXT PRIMARY KEY,
	token_hash TEXT NOT NULL UNIQUE,
	owner_id INTEGER NOT NULL REFERENCES owner (id),
	label TEXT NOT NULL,
	scopes TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER,
	revoked_at INTEGER
);

-- Fixed-window counters for auth endpoints (per IP / per purpose).
CREATE TABLE auth_rate_limits (
	key TEXT NOT NULL,
	window_start INTEGER NOT NULL,
	count INTEGER NOT NULL,
	PRIMARY KEY (key, window_start)
);

-- Batch guard: `INSERT INTO tx_guard (ok) VALUES (changes() = 1)` aborts the whole
-- D1 batch when the preceding conditional statement did not affect exactly one row.
-- Every batch that inserts a guard row deletes it again before finishing.
CREATE TABLE tx_guard (
	ok INTEGER NOT NULL CHECK (ok = 1)
);
