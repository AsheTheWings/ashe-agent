import { useState, type FormEvent } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useClient, useClientState } from "./client-context.tsx"

/** Asks for the server's WebSocket URL, prefilled with the remembered one, and the owner password. */
export const SignIn = () => {
  const client = useClient()
  const remembered = useClientState((state) => state.serverUrl)
  const error = useClientState((state) => state.error)
  const connecting = useClientState((state) => state.status === "connecting")
  const [serverUrl, setServerUrl] = useState(remembered ?? "")
  const [password, setPassword] = useState("")

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void client.signIn(serverUrl.trim(), password).then(() => setPassword(""))
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>ashe-agent</CardTitle>
          <CardDescription>Sign in to an ashe-agent server as its owner.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="server-url">Server URL</Label>
              <Input
                id="server-url"
                type="url"
                required
                placeholder="ws://host:port/"
                pattern="wss?://.+"
                value={serverUrl}
                onChange={(event) => setServerUrl(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Owner password</Label>
              <Input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {error !== null && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" disabled={connecting}>
              {connecting ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
