import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "interchange/index": "src/interchange/index.ts",
    "profiler/index": "src/profiler/index.ts",
    "schema/index": "src/schema/index.ts",
    "indexes/index": "src/indexes/index.ts",
    "graph-extension/index": "src/graph-extension/index.ts",
    "backend/sqlite/index": "src/backend/sqlite/index.ts",
    "backend/sqlite/local": "src/backend/sqlite/local.ts",
    "backend/sqlite/libsql": "src/backend/sqlite/libsql.ts",
    "backend/postgres/index": "src/backend/postgres/index.ts",
    "backend/postgres/pglite": "src/backend/postgres/pglite.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  external: [
    "better-sqlite3",
    "@libsql/client",
    "bun:sqlite",
    "pg",
    "@electric-sql/pglite",
    "@electric-sql/pglite-pgvector",
  ],
});
