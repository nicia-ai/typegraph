import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "core/index": "src/core/index.ts",
    "backend/sqlite/local-store": "src/backend/sqlite/local-store.ts",
    "backend/postgres/pglite-store": "src/backend/postgres/pglite-store.ts",
  },
  outDir: "dist",
  format: ["esm", "cjs"],
  dts: { only: true },
  clean: false,
});
