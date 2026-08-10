import { defineConfig } from "vitest/config";

import baseConfig from "./vitest.config";

/**
 * The test scope the scoped claims mutation run (`stryker.claims.config.json`)
 * uses.
 *
 * Stryker runs the whole included set once as a dry run before it mutates
 * anything, so the full package suite — 24 minutes, nearly all of it unrelated
 * to `src/store/claims/**` — cannot be that input. This narrows it to the
 * suites that exercise the claim vocabulary and its statement builders:
 *
 *  - the cross-backend integration suite on SQLite, where every claim behavior
 *    test lives (`tests/backends/integration/**`, registered through
 *    `createIntegrationTestSuite`). The libSQL and PGlite runs of that same
 *    suite are omitted: they assert the same cases through another driver, so
 *    they would multiply the run without killing a mutant the SQLite run
 *    misses;
 *  - the claim-facing unit and property suites, including the statement
 *    recorder's inventory of which claims each write path issues.
 *
 * The two-connection PostgreSQL concurrency suite is excluded by construction:
 * it needs `POSTGRES_URL` and skips itself without one, and timing-bound
 * assertions do not belong under a mutation runner.
 *
 * Declared as one flat project rather than by extending the base config's
 * `projects`, because a project list would keep selecting the whole package;
 * the alias map is reused from the base config so module resolution cannot
 * drift between the two.
 */
export default defineConfig({
  resolve: baseConfig.resolve,
  test: {
    globals: false,
    include: [
      "tests/backends/sqlite/sqlite-backend.test.ts",
      "tests/constraint-claim-inventory.test.ts",
      "tests/constraint-enforcement.test.ts",
      "tests/constraint-fence-capability.test.ts",
      "tests/constraint-write-fence.test.ts",
      "tests/property/claim-axis.test.ts",
      "tests/property/constraint-claims.test.ts",
    ],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
