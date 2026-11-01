import { useState, type FormEvent } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useClient, useClientState } from "./client-context.tsx"

/** The base-nova login-03 card, signing the server's owner in with GitHub. */
export const SignIn = () => {
  const client = useClient()
  const remembered = useClientState((state) => state.serverUrl)
  const error = useClientState((state) => state.error)
  const connecting = useClientState((state) => state.status === "connecting")
  const [serverUrl, setServerUrl] = useState(remembered ?? "")
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void client.signIn(serverUrl.trim())
  }
  return (
    <main className="bg-muted flex min-h-svh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">AsheAgent</CardTitle>
            <CardDescription>Sign in to your server with GitHub.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="server-url">Server URL</FieldLabel>
                  <Input id="server-url" type="url" required placeholder="wss://server.example/v1/ws"
                    pattern="wss?://.+" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} />
                </Field>
                {error !== null && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
                <Field>
                  <Button variant="outline" type="submit" disabled={connecting}>
                    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                      <path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.8.1-.8.1-.8 1.2.1 1.9 1.3 1.9 1.3 1 1.9 2.8 1.4 3.4 1 .1-.8.4-1.4.8-1.7-2.7-.3-5.5-1.3-5.5-6a4.7 4.7 0 0 1 1.2-3.2c-.1-.3-.5-1.6.1-3.3 0 0 1-.3 3.3 1.2a11.4 11.4 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 3 .1 3.3a4.7 4.7 0 0 1 1.2 3.2c0 4.7-2.8 5.7-5.5 6 .4.4.8 1.1.8 2.2v3.4c0 .3.2.7.8.6A12 12 0 0 0 12 .5Z" />
                    </svg>
                    {connecting ? "Signing in…" : "Continue with GitHub"}
                  </Button>
                </Field>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
