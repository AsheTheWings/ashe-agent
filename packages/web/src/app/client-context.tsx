import { createContext, useContext, type ReactNode } from "react"
import { useStore } from "zustand"
import type { ClientState, SessionClient } from "@/session/client.ts"

const ClientContext = createContext<SessionClient | null>(null)

export const ClientProvider = ({ client, children }: { client: SessionClient; children: ReactNode }) => (
  <ClientContext.Provider value={client}>{children}</ClientContext.Provider>
)

export const useClient = (): SessionClient => {
  const client = useContext(ClientContext)
  if (client === null) throw new Error("useClient needs a ClientProvider")
  return client
}

export const useClientState = <T,>(selector: (state: ClientState) => T): T => useStore(useClient().store, selector)
