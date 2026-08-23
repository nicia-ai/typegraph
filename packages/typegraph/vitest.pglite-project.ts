/**
 * Root-level suites that boot an in-process PGlite instance directly or
 * through a recorder helper. Keep this inventory explicit so the companion
 * ratchet can detect a new heavy suite before it inherits the five-second
 * pure-unit budget.
 */
export const PGLITE_TEST_FILES = [
  "tests/capability-bundle-dialect-honesty.test.ts",
  "tests/capability-declaration-validation.test.ts",
  "tests/constraint-claim-inventory.test.ts",
  "tests/constraint-write-fence.test.ts",
  "tests/contribution-rebuild-lock.test.ts",
  "tests/edge-convergence-command.test.ts",
  "tests/fused-edge-endpoints.test.ts",
  "tests/guarded-edge-cardinality-claim.test.ts",
  "tests/lock-fence-plan.test.ts",
  "tests/lock-fence-refusal.test.ts",
  "tests/materialize-trigram-extension.test.ts",
  "tests/node-claim-write-fusion.test.ts",
  "tests/node-fulltext-write-fusion.test.ts",
  "tests/node-vector-write-fusion.test.ts",
  "tests/schema-fused-insert.test.ts",
  "tests/schema-graph-write-fence.test.ts",
  "tests/write-plan-fence-threading.test.ts",
  "tests/write-plan-statement-order.test.ts",
] as const;

export const PGLITE_GLOBS = [
  "tests/backends/postgres/pglite-*.test.ts",
  ...PGLITE_TEST_FILES,
] as const;
