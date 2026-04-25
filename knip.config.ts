import type { KnipConfig } from "knip";

const config: KnipConfig = {
  workspaces: {
    "packages/typegraph": {
      entry: [
        "src/**/index.ts",
        "examples/*.ts",
        "test-d/**/*.test-d.ts",
        "type-smoke/**/*.ts",
      ],
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
        "src/backend/drizzle/vector-index.ts",
        "src/core/embedding.ts",
        "src/core/external-ref.ts",
        "src/core/searchable.ts",
      ],
    },
    "apps/docs": {
      entry: ["src/**/*.{astro,ts,tsx}"],
      project: ["src/**/*.{astro,ts,tsx}"],
      // Astro/Starlight plugins loaded via config
      ignoreDependencies: ["@astrojs/starlight-tailwind", "tailwindcss"],
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
