import type { FormEvent } from "react"
import { useEffect, useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldGroup } from "@/components/ui/field"
import { useClient, useClientState } from "./client-context.tsx"

/** The base-nova login-03 card, signing the server's owner in with the server's enabled methods. */
export const SignIn = () => {
  const client = useClient()
  const error = useClientState((state) => state.error)
  const connecting = useClientState((state) => state.status === "connecting")
  const [password, setPassword] = useState("")
  const [methods, setMethods] = useState<{ readonly github: boolean; readonly password: boolean } | null>(null)
  useEffect(() => {
    let active = true
    void client.authMethods().then((resolved) => {
      if (active) setMethods(resolved)
    })
    return () => {
      active = false
    }
  }, [client])
  const showPassword = methods?.password ?? false
  const showGithub = methods?.github ?? false
  const submitGithub = (event: FormEvent) => {
    event.preventDefault()
    void client.signIn()
  }
  const submitPassword = (event: FormEvent) => {
    event.preventDefault()
    const attempt = password
    setPassword("")
    void client.signInWithPassword(attempt)
  }
  const description =
    methods === null
      ? "Checking sign-in methods…"
      : showPassword && !showGithub
        ? "Sign in to your development server with its password."
        : showPassword && showGithub
          ? "Sign in to your development server with its password or GitHub."
          : showGithub
            ? "Sign in to your server with GitHub."
            : "No sign-in methods are enabled on this server."
  return (
    <main className="bg-muted flex min-h-svh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">AsheAgent</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {error !== null && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
            {showPassword && (
              <form onSubmit={submitPassword}>
                <FieldGroup>
                  <Field>
                    <input
                      type="password"
                      autoComplete="current-password"
                      aria-label="Development password"
                      placeholder="Development password"
                      className="border-input bg-transparent h-8 w-full min-w-0 rounded-lg border px-2.5 py-1 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </Field>
                  <Field>
                    <Button type="submit" disabled={connecting || password === ""}>
                      {connecting ? "Signing in…" : "Sign in"}
                    </Button>
                  </Field>
                </FieldGroup>
              </form>
            )}
            {showGithub && (
              <form onSubmit={submitGithub}>
                <FieldGroup>
                  <Field>
                    <Button variant="outline" type="submit" disabled={connecting}>
                      <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                        <path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.8.1-.8.1-.8 1.2.1 1.9 1.3 1.9 1.3 1 1.9 2.8 1.4 3.4 1 .1-.8.4-1.4.8-1.7-2.7-.3-5.5-1.3-5.5-6a4.7 4.7 0 0 1 1.2-3.2c-.1-.3-.5-1.6.1-3.3 0 0 1-.3 3.3 1.2a11.4 11.4 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 3 .1 3.3a4.7 4.7 0 0 1 1.2 3.2c0 4.7-2.8 5.7-5.5 6 .4.4.8 1.1.8 2.2v3.4c0 .3.2.7.8.6A12 12 0 0 0 12 .5Z" />
                      </svg>
                      {connecting ? "Signing in…" : showPassword ? "Continue with GitHub instead" : "Continue with GitHub"}
                    </Button>
                  </Field>
                </FieldGroup>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
