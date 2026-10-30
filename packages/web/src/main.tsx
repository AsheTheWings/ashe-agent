import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app/app.tsx"
import { ClientProvider } from "./app/client-context.tsx"
import { browserPorts } from "./session/browser-ports.ts"
import { SessionClient } from "./session/client.ts"
import "./index.css"

const client = new SessionClient(browserPorts())
client.resume()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ClientProvider client={client}>
      <App />
    </ClientProvider>
  </StrictMode>,
)
