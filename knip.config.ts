import type { KnipConfig } from "knip";

const config: KnipConfig = {
  workspaces: {
    "packages/typegraph": {
      entry: [
        "src/**/index.ts",
        "examples/*.ts",
        "test-d/**/*.test-d.ts",
        "type-smoke/**/*.ts",
        // workerd entry for the do-sqlite test lane: its default export
        // is loaded by @cloudflare/vitest-pool-workers, not imported.
        "tests/do-sqlite/worker.ts",
      ],
      // `cloudflare:test` / `cloudflare:workers` are workerd virtual
      // modules provided by the pool at runtime, not npm packages.
      ignoreDependencies: ["cloudflare"],
      project: [
        "src/**/*.ts",
        "tests/**/*.ts",
        "examples/**/*.ts",
        "test-d/**/*.ts",
        "type-smoke/**/*.ts",
      ],
      ignore: [
        "**/test-utils.ts",
        // Public API utilities for advanced users (schema introspection, vector operations)
        "src/backend/drizzle/columns/vector.ts",
        "src/core/embedding.ts",
        "src/core/external-ref.ts",
        "src/core/searchable.ts",
        // The write-pipeline seam. It lands ahead of its consumers: the write
        // paths move onto it one module per batch, so until the last batch
        // some of its surface is reachable only from the suites that pin the
        // seam. Each entry is deleted by the batch that consumes the module.
        "src/store/operations/write-plan.ts",
        "src/store/operations/write-fences.ts",
        "src/store/operations/write-session.ts",
        "src/store/operations/write-executor.ts",
      ],
    },
    "apps/docs": {
      entry: ["src/**/*.{astro,ts,tsx}"],
      project: ["src/**/*.{astro,ts,tsx}"],
    },
    "packages/benchmarks": {
      // Neo4j head-to-head harness is a standalone package installed with
      // pnpm --ignore-workspace. Its src files are entrypoints invoked
      // from its own package.json scripts; the monorepo never imports
      // them.
      ignore: ["neo4j-compare/**"],
      // sqlite-vec is loaded dynamically via createRequire so the optional
      // peer dep stays optional; knip's static scan doesn't see it.
      ignoreDependencies: ["sqlite-vec"],
    },
  },
};

export default config;
