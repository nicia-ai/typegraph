import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "interchange/index": "src/interchange/index.ts",
    "profiler/index": "src/profiler/index.ts",
    "schema/index": "src/schema/index.ts",
    "indexes/index": "src/indexes/index.ts",
    "backend/sqlite/index": "src/backend/sqlite/index.ts",
    "backend/sqlite/local": "src/backend/sqlite/local.ts",
    "backend/postgres/index": "src/backend/postgres/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  external: ["better-sqlite3", "@libsql/client", "bun:sqlite", "pg"],
});
