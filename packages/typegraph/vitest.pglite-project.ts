/**
 * Root-level suites that boot an in-process PGlite instance directly or
 * through a recorder helper. Keep this inventory explicit so the companion
 * ratchet can detect a new heavy suite before it inherits the five-second
 * pure-unit budget.
 */
export const PGLITE_TEST_FILES = [
  "tests/atomic-generated-edge-batch-pglite.test.ts",
  "tests/atomic-generated-node-batch-pglite.test.ts",
  "tests/atomic-mutation-program-pglite-routing.test.ts",
  "tests/atomic-node-batch-sql.test.ts",
  "tests/atomic-resolved-update-batch-pglite.test.ts",
  "tests/atomic-transport-conformance.test.ts",
  "tests/base-schema-adoption.test.ts",
  "tests/capability-bundle-dialect-honesty.test.ts",
  "tests/capability-declaration-validation.test.ts",
  "tests/constraint-claim-inventory.test.ts",
  "tests/constraint-write-fence.test.ts",
  "tests/contribution-rebuild-lock.test.ts",
  "tests/durable-edge-match-identity.test.ts",
  "tests/edge-convergence-command.test.ts",
  "tests/edge-match-identity-ddl.test.ts",
  "tests/engine-catalog-probes.test.ts",
  "tests/engine-operation-layer-transaction-scope.test.ts",
  "tests/engine-profile-derivable-keys.test.ts",
  "tests/engine-profile-derivation.test.ts",
  "tests/engine-profile-parity.test.ts",
  "tests/engine-profile-refusals.test.ts",
  "tests/fused-edge-endpoints.test.ts",
  "tests/guarded-edge-cardinality-claim.test.ts",
  "tests/import-edge-match-identity-atomicity.test.ts",
  "tests/lock-fence-plan.test.ts",
  "tests/lock-fence-refusal.test.ts",
  "tests/materialize-trigram-extension.test.ts",
  "tests/node-claim-write-fusion.test.ts",
  "tests/node-fulltext-write-fusion.test.ts",
  "tests/node-vector-write-fusion.test.ts",
  "tests/recorded-capture-write-parity.test.ts",
  "tests/schema-fence-plan.test.ts",
  "tests/schema-fused-insert.test.ts",
  "tests/schema-graph-write-fence.test.ts",
  "tests/schema-kind-emptiness.test.ts",
  "tests/subgraph-membership-postgres.test.ts",
  "tests/write-plan-fence-threading.test.ts",
  "tests/write-plan-statement-order.test.ts",
] as const;

export const PGLITE_GLOBS = [
  "tests/backends/postgres/pglite-*.test.ts",
  ...PGLITE_TEST_FILES,
] as const;
