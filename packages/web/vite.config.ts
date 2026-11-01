import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // Production uses the page's origin; the development entry point supplies its endpoint.
  define: { __ASHE_AGENT_DEV_SERVER_URL__: "null" },
  envDir: false,
  envPrefix: [],
  server: { host: "127.0.0.1" },
})
