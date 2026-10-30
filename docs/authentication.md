# Authentication

ashe-agent has one owner. Clients act as the owner either through a
login with the owner password or through a named API token.

## Owner password and logins

`ashe-agent owner set-password` stores the password's argon2id hash. Until
a password is set, every login is refused, and no protocol method sets
one. Setting it again signs every login out: its tokens stop working and
its open connections close, and a login still checking the old password
when the change commits fails.

A login returns an access token valid for 15 minutes and a refresh token
valid for 30 days. `auth.refresh` exchanges a refresh token for a new pair
and retires the one it used. Presenting a retired refresh token again,
even after it expired, revokes the whole login, so a stolen and replayed
token stops working for its thief and its owner alike. A revoked login's
access tokens stop working too.

After 5 failed logins within 15 minutes, logins are refused, without the
password being checked, until 15 minutes after the fifth failure; the
error's `data.retryAt` says when. Login attempts run one at a time, so
concurrent attempts count against the limit in turn and never verify
passwords in parallel.

## API tokens

`ashe-agent token create <name>` prints a new API token once. Names are
unique among active tokens; a revoked token's name can be used again, for
a new token with a new identity. Revoking a token closes every open
connection it authenticated within about a second, and refuses it from
then on.

## Connections

A connection must authenticate with its first message, within 10
seconds, by `auth.login`, `auth.refresh`, or `auth.authenticate` with an
access token or an API token. Any other first message, a failed
authentication, an unsupported protocol version, or silence closes the
connection with WebSocket close code 1008. A browser connection whose
`Origin` header names an origin outside `ASHE_AGENT_ORIGINS` is refused
before the upgrade.

Every request on an authenticated connection first checks that its login
or API token is still active, and a revoked one closes the connection
instead of being answered.

## Storage

The database stores the password only as its argon2id hash and every
token only as its SHA-256 hash.
