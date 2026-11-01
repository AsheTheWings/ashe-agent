# Authentication

AsheAgent serves one owner, identified by a configured numeric GitHub user
ID. Browser clients sign in with GitHub; programs use named API tokens.

## GitHub sign-in

The client generates a 256-bit verifier and keeps it and the server URL in
its tab's `sessionStorage`. It navigates to `GET /v1/auth/github/start`
with its origin and the verifier's base64url SHA-256 challenge. The server
accepts only a configured origin and a 43-character base64url challenge.
It redirects to GitHub with a fresh state and a separate server-held PKCE
verifier, the registered callback URL, `allow_signup=false`, and no scopes.

The server holds at most 64 pending sign-ins for ten minutes each. A new
one evicts the oldest; an evicted owner starts again. The first callback
consumes its state. An unknown, expired, or reused state receives 400.
GitHub denial returns `signInError=denied`; missing codes, malformed
answers, and failed or timed-out GitHub requests return
`signInError=github_failed`. Each GitHub request has a ten-second deadline.

The callback exchanges the GitHub code using the server verifier, fetches
`/user`, and accepts only the configured numeric user ID, never the login
name. Another user returns `signInError=not_owner`. The server revokes the
GitHub token after the lookup regardless of its outcome; failed revocation
emits a bounded log record and preserves the sign-in result.

For the owner, the callback redirects to the client's origin with
`#signIn=<code>`. The code has 256 random bits, lasts 60 seconds, and is bound
to the client's challenge. The client removes the fragment before connecting
and sends `auth.exchange` with the code, verifier, and protocol version.
The first exchange consumes the code even when authentication fails.
Pending sign-ins and codes live only in server memory and disappear on a
restart. GitHub credentials and codes are absent from persistence and
telemetry. Sign-in HTTP responses set `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`.

## Logins

A successful exchange creates a login tied to the owner's GitHub ID and
returns an access token valid for 15 minutes and a refresh token valid for
30 days. `auth.refresh` exchanges a refresh token for a new pair and
retires the one it used. Presenting a retired token again, even after it
expires, revokes the entire login and all its access tokens.

Changing the configured owner refuses every other login's access and
refresh tokens. Open connections of an inactive login close. The client
keeps access tokens in memory and refresh tokens in `localStorage`; see
[web client](web-client.md#signing-in).

## API tokens

`ashe-agent token create <name>` prints an API token once. Names are unique
among active tokens; a revoked token's name can be reused with a new
identity. Revocation closes its connections within about a second and
refuses all further authentication. API tokens are independent of logins
and the configured GitHub owner.

## Connections and storage

A connection authenticates with its first message within ten seconds, by
`auth.exchange`, `auth.refresh`, or `auth.authenticate` with an access or API
token. A failed authentication, unsupported version, other first message,
or silence closes it with WebSocket code 1008. An unlisted browser origin
is refused before upgrading. Every authenticated request checks that its
principal remains active.

The database stores AsheAgent tokens only as SHA-256 hashes, with each
login's GitHub user ID. [Setup](../README.md#use) explains the OAuth app;
the [input catalog](../schemas/config.schema.json) defines its inputs.
