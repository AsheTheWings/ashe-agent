-- The owner password, logins with their access and refresh tokens, failed
-- login attempts, and named API tokens. Tokens are stored only as SHA-256
-- hashes and the password only as its argon2id hash.
CREATE TABLE owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE login_failures (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL
) STRICT;

-- One row per successful login; its refresh tokens form one family.
CREATE TABLE logins (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;

CREATE TABLE refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  login_id TEXT NOT NULL REFERENCES logins (id),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  rotated_at INTEGER
) STRICT;

CREATE INDEX refresh_tokens_login ON refresh_tokens (login_id);

CREATE TABLE access_tokens (
  token_hash TEXT PRIMARY KEY,
  login_id TEXT NOT NULL REFERENCES logins (id),
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX access_tokens_login ON access_tokens (login_id);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
) STRICT;

CREATE UNIQUE INDEX api_tokens_active_name ON api_tokens (name) WHERE revoked_at IS NULL;
