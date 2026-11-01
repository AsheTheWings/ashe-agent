import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app/app.tsx"
import { ClientProvider } from "./app/client-context.tsx"
import { browserPorts } from "./session/browser-ports.ts"
import { SessionClient } from "./session/client.ts"
import { serverEndpoint } from "./session/server-endpoint.ts"
import "./index.css"

declare const __ASHE_AGENT_DEV_SERVER_URL__: string | null

const client = new SessionClient(browserPorts(serverEndpoint(window.location.origin, __ASHE_AGENT_DEV_SERVER_URL__)))
client.resume()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ClientProvider client={client}>
      <App />
    </ClientProvider>
  </StrictMode>,
)
