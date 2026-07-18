import { resolve } from "node:path";

import {
  cloudflarePool,
  cloudflareTest,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * #140: Cloudflare Durable Objects SQLite (`do-sqlite`) test harness.
 *
 * Runs in a real `workerd` runtime via `@cloudflare/vitest-pool-workers`
 * (0.16.x Vitest-4 pool architecture: a Vite plugin + a pool runner
 * initializer fed the same options) so the suite exercises genuine
 * `ctx.storage` transaction semantics — not a Node fake. Separate from
 * `vitest.config.ts` because the workers pool is incompatible with the
 * Node-environment suite; invoked through the `test:do` script,
 * mirroring how `test:postgres` is its own lane.
 */
const workersOptions = {
  main: "./tests/do-sqlite/worker.ts",
  wrangler: { configPath: "./tests/do-sqlite/wrangler.jsonc" },
};

export default defineConfig({
  plugins: [cloudflareTest(workersOptions)],
  resolve: {
    alias: {
      "@nicia-ai/typegraph/adapters/drizzle/sqlite": resolve(
        __dirname,
        "src/backend/sqlite/index.ts",
      ),
      "@nicia-ai/typegraph": resolve(__dirname, "src/index.ts"),
    },
  },
  test: {
    include: ["tests/do-sqlite/**/*.test.ts"],
    pool: cloudflarePool(workersOptions),
  },
});
