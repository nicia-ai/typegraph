/**
 * The one route a statement composed on a backend's Drizzle handle takes to
 * the connection.
 *
 * Most statements a backend issues go through its execution adapter, which
 * admits them through the transaction's view (`./transaction-view`) and, on a
 * pinned PostgreSQL connection, through the connection's statement queue
 * (`./statement-queue`). Some members compose their statement with Drizzle's
 * query builder on the handle itself instead (`db.insert(...)`,
 * `db.select(...)`, `db.execute(...)`, `db.run(...)`): marker and
 * materialization rows, graph templates, lazy DDL, maintenance. When the
 * handle is a transaction's (a backend a public constructor built over a
 * transaction's native handle), such a statement would reach the driver
 * without the view, so a backend kept past the transaction's end would write
 * outside it: in autocommit, or inside the next transaction on the
 * connection.
 *
 * {@link runHandleStatement} hands the statement to the adapter's
 * `admitHandleStatement`, which admits it exactly as the adapter admits its
 * own statements. `tests/drizzle-handle-statement-ratchet.test.ts` holds every
 * backend module to this route: a call on a Drizzle handle outside a
 * `runHandleStatement` callback must be listed there with its reason.
 *
 * Edge-safe: no `node:*` imports.
 */
import type { SqlExecutionAdapter } from "./types";

/**
 * Runs a statement with no admission of its own: the adapter member of an
 * adapter that neither queues nor closes (a pooled or root connection).
 */
export function admitHandleStatementDirectly<T>(
  statement: () => Promise<T>,
): Promise<T> {
  return statement();
}

/**
 * Runs `statement`, composed on the Drizzle handle `adapter` executes on,
 * through `adapter`'s admission: refused with a `TransactionClosedError` once
 * the transaction the handle belongs to has ended, and serialized with the
 * adapter's other statements on a pinned connection. `statement` may return a
 * Drizzle query builder; it is awaited inside the admission.
 */
export function runHandleStatement<T>(
  adapter: Pick<SqlExecutionAdapter, "admitHandleStatement">,
  statement: () => T | PromiseLike<T>,
): Promise<T> {
  const admit = adapter.admitHandleStatement ?? admitHandleStatementDirectly;
  return admit(async () => await statement());
}
