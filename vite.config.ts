import path from "node:path"
import { defineConfig } from "vite"

export default defineConfig({
  optimizeDeps: {
    include: ["@tscircuit/core"],
  },
  resolve: {
    alias: {
      "@tscircuit/core": path.resolve(
        import.meta.dirname,
        "scripts/generate-repro/node_modules/@tscircuit/core",
      ),
      lib: path.resolve(import.meta.dirname, "lib"),
      tests: path.resolve(import.meta.dirname, "tests"),
    },
  },
})
