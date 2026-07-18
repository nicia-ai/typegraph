import { resolve } from "node:path";

import { configDefaults, defineConfig } from "vitest/config";

/**
 * Test globs for the graph-merge subsystem. These suites exercise an in-process
 * PGlite (WASM Postgres) backend and run on BOTH backends, so they get their own
 * project with file serialization + generous timeouts. The rest of the package
 * keeps default parallelism and fast-fail timeouts.
 */
const UNIT_SCOPE = process.env.TYPEGRAPH_TEST_SCOPE === "unit";

const GRAPH_MERGE_GLOBS = [
  "tests/graph-merge/**/*.test.ts",
  ...(UNIT_SCOPE ? [] : ["tests/property/graph-merge/**/*.test.ts"]),
];

const SHARED_EXCLUDE = [
  ...configDefaults.exclude,
  // #140: workerd-only do-sqlite suite — runs via `test:do`
  // (vitest.workers.config.ts), not the Node suite.
  "tests/do-sqlite/**",
  "**/dist/**",
  "**/.{idea,git,cache,output,temp}/**",
  "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc}.config.*",
];

const UNIT_PROPERTY_EXCLUDE = UNIT_SCOPE ? ["tests/property/**"] : [];

export default defineConfig({
  resolve: {
    alias: {
      "@nicia-ai/typegraph/sqlite/local": resolve(
        __dirname,
        "src/backend/sqlite/local-store.ts",
      ),
      "@nicia-ai/typegraph/postgres/pglite": resolve(
        __dirname,
        "src/backend/postgres/pglite-store.ts",
      ),
      "@nicia-ai/typegraph/indexes": resolve(__dirname, "src/indexes/index.ts"),
      "@nicia-ai/typegraph/interchange": resolve(
        __dirname,
        "src/interchange/index.ts",
      ),
      "@nicia-ai/typegraph/adapters/drizzle/postgres/pglite": resolve(
        __dirname,
        "src/backend/postgres/pglite.ts",
      ),
      "@nicia-ai/typegraph/adapters/drizzle/postgres": resolve(
        __dirname,
        "src/backend/postgres/index.ts",
      ),
      "@nicia-ai/typegraph/profiler": resolve(
        __dirname,
        "src/profiler/index.ts",
      ),
      "@nicia-ai/typegraph/schema": resolve(__dirname, "src/schema/index.ts"),
      "@nicia-ai/typegraph/graph-merge": resolve(
        __dirname,
        "src/graph-merge/index.ts",
      ),
      "@nicia-ai/typegraph/adapters/drizzle/sqlite/local": resolve(
        __dirname,
        "src/backend/sqlite/local.ts",
      ),
      "@nicia-ai/typegraph/adapters/drizzle/sqlite/libsql": resolve(
        __dirname,
        "src/backend/sqlite/libsql.ts",
      ),
      "@nicia-ai/typegraph/adapters/drizzle/sqlite": resolve(
        __dirname,
        "src/backend/sqlite/index.ts",
      ),
      "@nicia-ai/typegraph": resolve(__dirname, "src/index.ts"),
    },
  },
  test: {
    globals: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/backend/drizzle/ddl.ts"],
      thresholds: {
        branches: 64,
        functions: 74,
        lines: 75,
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "main",
          include: ["tests/**/*.test.ts"],
          // Graph-merge runs under its own (serialized) project below.
          exclude: [
            ...SHARED_EXCLUDE,
            ...GRAPH_MERGE_GLOBS,
            ...UNIT_PROPERTY_EXCLUDE,
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "graph-merge",
          include: GRAPH_MERGE_GLOBS,
          exclude: SHARED_EXCLUDE,
          // PGlite boots an in-process Postgres per fixture. Serialize files and
          // use generous budgets so normal PGlite startup/cleanup latency does
          // not masquerade as a correctness failure. Scoped to this project so
          // the rest of the package keeps default parallelism + fast timeouts.
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
