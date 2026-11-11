-- Each login records the GitHub user it was issued for. Logins from before
-- GitHub sign-in have no such user, so they are removed with their access
-- and refresh tokens, and the three tables are created again.
DROP TABLE access_tokens;
DROP TABLE refresh_tokens;
DROP TABLE logins;

-- One row per sign-in; its refresh tokens form one family.
CREATE TABLE logins (
  id TEXT PRIMARY KEY,
  github_user_id INTEGER NOT NULL,
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
