# Sign-in gateway

The gateway image lets only one GitHub account reach a public deployment
of the server and the web client. It is
[oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/), from the
release image that
[`images/gateway/Containerfile`](../images/gateway/Containerfile) pins by
digest. The
gateway runs in front of the server's own sign-in, which it does not
replace: a browser that passes the gateway still signs in with the owner
password, and the server never reads identity from the gateway's headers.

## Building and qualifying

`bun run gateway-image`, from a commit with no uncommitted changes and
with `ORAS` naming an `oras` executable, builds the image and writes it,
annotated, to the OCI layout `dist/gateway-image` under the tag
`qualified`. It runs `scripts/image.sh build gateway` and then `push`, as
the [web image](web-client.md#container-image) does.
`bun run test:gateway-image <layout> <revision>` qualifies an image in an
OCI layout; see [testing](testing.md).

## Running it

The container listens on port 4180 as UID 65532 and runs read-only with
no capabilities. It takes its whole configuration as arguments:

```sh
--http-address=0.0.0.0:4180
--provider=github
--client-id=<OAuth app client ID>
--client-secret-file=<path of the OAuth app client secret>
--cookie-secret-file=<path of the cookie secret>
--github-user=<the one GitHub login allowed>
--email-domain=*
'--scope=user:email read:org'
--upstream=static://200
--redirect-url=https://<origin>/oauth2/callback
--reverse-proxy=true
--cookie-expire=720h
--skip-provider-button=true
--request-logging=false
--auth-logging=false
--standard-logging=false
```

`--github-user` decides who gets through; `--email-domain=*` only stops
the email check from refusing that user. Every sign-in reads the user's
organizations and teams, so the scope needs `read:org` besides
`user:email`; it grants no access to repositories. GitHub OAuth apps issue
no refresh tokens, so a session lasts the cookie's 30 days, after which the
gateway sends the browser to GitHub again. With logging off, the container prints
one line at startup, `Warning: Logging disabled`, and nothing after.

Create the GitHub OAuth app with `https://<origin>` as its homepage and
`https://<origin>/oauth2/callback` as its callback URL. The client secret
file holds the secret alone, with no trailing newline, since the gateway
sends its bytes as they are. The cookie secret is 32 random bytes in
base64url, which the gateway decodes into its key:

```sh
python3 -c 'import base64, os; print(base64.urlsafe_b64encode(os.urandom(32)).decode(), end="")'
```

## One origin

The gateway's cookie covers one origin, so serve the web client, the
server's WebSocket endpoint, and the gateway's `/oauth2/` paths from that
origin, behind a reverse proxy that asks the gateway about every other
request. With Caddy:

```caddyfile
<origin> {
	handle /oauth2/* {
		reverse_proxy 127.0.0.1:<gateway port> {
			header_up X-Real-IP {remote_host}
			header_up X-Forwarded-Uri {uri}
		}
	}
	handle {
		forward_auth 127.0.0.1:<gateway port> {
			uri /oauth2/auth
			header_up X-Real-IP {remote_host}
			@error status 401
			handle_response @error {
				redir * /oauth2/sign_in
			}
		}
		reverse_proxy /v1/ws 127.0.0.1:<server port>
		reverse_proxy 127.0.0.1:<web image port>
	}
}
```

A signed-in browser returns to `/`, where the client lives. The server's
`ASHE_AGENT_ORIGINS` lists `https://<origin>`, and the client
signs in with `wss://<origin>/v1/ws`. The browser sends the gateway's
cookie with the WebSocket upgrade, so a connection opened after the
session expired is refused until the page is reloaded and the browser
signs in to GitHub again.
