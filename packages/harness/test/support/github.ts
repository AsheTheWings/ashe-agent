import { Redacted } from "effect"
import { challengeOf, randomToken, type GithubSignInConfig } from "../../src/auth/github.ts"

/** Run-owned GitHub HTTP endpoints with synthetic credentials and observable requests. */
export class FakeGithub {
  user: unknown = { id: 42 }
  token: unknown = { access_token: "synthetic-github-token" }
  tokenStatus = 200
  userStatus = 200
  revokeStatus = 204
  hang: "token" | "user" | null = null
  readonly requests: Array<{ path: string; method: string; body: string; authorization: string | null }> = []
  private readonly server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      this.requests.push({ path, method: request.method, body: await request.text(), authorization: request.headers.get("authorization") })
      if (path === "/login/oauth/access_token") {
        if (this.hang === "token") return new Promise<Response>(() => {})
        return Response.json(this.token, { status: this.tokenStatus })
      }
      if (path === "/user") {
        if (this.hang === "user") return new Promise<Response>(() => {})
        return Response.json(this.user, { status: this.userStatus })
      }
      if (path === "/applications/test-client/token") return new Response(null, { status: this.revokeStatus })
      return new Response(null, { status: 404 })
    },
  })
  get base() { return `http://127.0.0.1:${this.server.port}` }
  get config(): GithubSignInConfig {
    return { clientId: "test-client", clientSecret: Redacted.make("synthetic-github-secret"), ownerId: 42, callbackUrl: "http://127.0.0.1/callback", githubUrl: this.base, githubApiUrl: this.base }
  }
  stop() { this.server.stop(true) }
}

export const httpUrl = (url: string, path: string) => {
  const http = new URL(url)
  http.protocol = "http:"
  http.pathname = path
  http.search = ""
  return http
}

/** Starts a real HTTP sign-in and returns the authorize URL without following it. */
export const startSignIn = async (url: string, verifier = randomToken()) => {
  const start = httpUrl(url, "/v1/auth/github/start")
  start.searchParams.set("origin", "http://127.0.0.1:5173")
  start.searchParams.set("challenge", challengeOf(verifier))
  const response = await fetch(start, { redirect: "manual" })
  return { response, authorize: new URL(response.headers.get("location")!), verifier }
}

export const callback = (url: string, state: string, params: Record<string, string> = { code: "synthetic-code" }) => {
  const address = httpUrl(url, "/v1/auth/github/callback")
  address.search = new URLSearchParams({ state, ...params }).toString()
  return fetch(address, { redirect: "manual" })
}

export const signInCode = async (url: string) => {
  const { authorize, verifier } = await startSignIn(url)
  const response = await callback(url, authorize.searchParams.get("state")!)
  const code = new URLSearchParams(new URL(response.headers.get("location")!).hash.slice(1)).get("signIn")!
  return { code, verifier }
}
