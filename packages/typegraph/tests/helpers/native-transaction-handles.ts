import type { IntegrationLaneDriver } from "../backends/integration/test-context";

/**
 * Drivers whose transaction callback receives a NEW native object per BEGIN,
 * so the handle alone tells one transaction from the next. better-sqlite3
 * hands every TypeGraph-owned transaction the long-lived database object,
 * which identifies the connection, not the transaction.
 *
 * Asserted per driver by `native-transaction-handle-probes.ts`.
 */
export const PER_BEGIN_NATIVE_DRIVERS: ReadonlySet<IntegrationLaneDriver> =
  new Set(["libsql", "pglite", "node-postgres", "postgres-js"]);
