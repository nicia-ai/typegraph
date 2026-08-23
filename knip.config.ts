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
        // `scripts/size-budget/index.ts` is already an entry via its
        // `test:size` package.json script, but knip only parses a file's
        // imports (and therefore its dependency usage) when the file is
        // also within `project` — an entry outside `project` is registered
        // as reachable but not examined. Without this, `esbuild` (imported
        // by `measure.ts`, several hops from the entry) reads as unused.
        "scripts/size-budget/*.ts",
      ],
      ignore: [
        "**/test-utils.ts",
        // Public API utilities for advanced users (schema introspection, vector operations)
        "src/backend/drizzle/columns/vector.ts",
        "src/core/embedding.ts",
        "src/core/external-ref.ts",
        "src/core/searchable.ts",
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
