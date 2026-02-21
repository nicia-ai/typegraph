import { resolve } from "node:path";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@nicia-ai/typegraph/indexes": resolve(__dirname, "src/indexes/index.ts"),
      "@nicia-ai/typegraph/interchange": resolve(
        __dirname,
        "src/interchange/index.ts",
      ),
      "@nicia-ai/typegraph/postgres": resolve(
        __dirname,
        "src/backend/postgres/index.ts",
      ),
      "@nicia-ai/typegraph/profiler": resolve(
        __dirname,
        "src/profiler/index.ts",
      ),
      "@nicia-ai/typegraph/sqlite/local": resolve(
        __dirname,
        "src/backend/sqlite/local.ts",
      ),
      "@nicia-ai/typegraph/sqlite": resolve(
        __dirname,
        "src/backend/sqlite/index.ts",
      ),
      "@nicia-ai/typegraph": resolve(__dirname, "src/index.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      "**/dist/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc}.config.*",
    ],
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
  },
});
