import { LogOutIcon } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useClient, useClientState } from "./client-context.tsx"
import { SessionPane } from "./session-pane.tsx"
import { SessionList } from "./sessions.tsx"
import { SignIn } from "./sign-in.tsx"

const Workspace = () => {
  const client = useClient()
  const status = useClientState((state) => state.status)
  const error = useClientState((state) => state.error)
  const active = useClientState((state) => state.activeSessionId)

  return (
    <div className="flex h-svh flex-col">
      {status === "reconnecting" && (
        <Alert className="rounded-none border-x-0 border-t-0">
          <AlertDescription>The connection dropped; reconnecting…</AlertDescription>
        </Alert>
      )}
      {status === "connected" && error !== null && (
        <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="flex flex-col">
          <SessionList />
          <div className="bg-muted/30 border-e border-t p-2">
            <Button variant="ghost" size="sm" onClick={() => client.signOut()}>
              <LogOutIcon /> Sign out
            </Button>
          </div>
        </div>
        {active === null ? (
          <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
            Open a session or create one.
          </div>
        ) : (
          <SessionPane key={active} />
        )}
      </div>
    </div>
  )
}

export const App = () => {
  const signedIn = useClientState((state) => state.status !== "signedOut" && state.principal !== null)
  return <TooltipProvider>{signedIn ? <Workspace /> : <SignIn />}</TooltipProvider>
}
