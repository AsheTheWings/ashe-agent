import { readFileSync } from "node:fs"

/** Vitest runs only the checkpoint saver's validation suite; every other test runs on bun test. */
export default {
  plugins: [
    {
      // Bun imports migration files as text; Vite needs the same for the code under test.
      name: "sql-as-text",
      load(id: string) {
        const path = id.split("?")[0]!
        return path.endsWith(".sql") ? `export default ${JSON.stringify(readFileSync(path, "utf8"))}` : null
      },
    },
  ],
  test: {
    include: ["packages/*/test/**/*.vitest.ts"],
    globals: true,
  },
}
