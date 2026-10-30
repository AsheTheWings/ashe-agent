import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // The client reads no environment of its own; the server URL is entered at sign-in.
  envDir: false,
  envPrefix: [],
  server: { host: "127.0.0.1" },
})
