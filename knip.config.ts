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
      ],
    },
    "apps/docs": {
      entry: ["src/**/*.{astro,ts,tsx}"],
      project: ["src/**/*.{astro,ts,tsx}"],
      // Astro/Starlight plugins loaded via config
      ignoreDependencies: ["@astrojs/starlight-tailwind", "tailwindcss"],
    },
  },
};

export default config;
