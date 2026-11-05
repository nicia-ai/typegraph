/**
 * A backend whose graph-write fence is an advisory lock and nothing else: its
 * transactions name no fences relation, so the fence acquisition cannot
 * advance a fence row, and they expose no fused schema + graph fence. This is
 * the shape of a custom port that implements `pg_advisory_xact_lock` but
 * stores no TypeGraph fence rows.
 *
 * Such a port cannot detect a stale snapshot at the fence, so every decision
 * the fence alone protects must refuse a snapshot isolation on it.
 */
import {
  deriveBackend,
  projectBackendWithout,
} from "../src/backend/derive-backend";
import type { GraphBackend, TransactionBackend } from "../src/backend/types";

function withoutFenceRow(transaction: TransactionBackend): TransactionBackend {
  const lockOnly: TransactionBackend = projectBackendWithout(transaction, [
    "lockSchemaVersionAndGraphWrite",
  ]);
  const { tableNames } = transaction;
  if (tableNames === undefined) return lockOnly;
  return deriveBackend(lockOnly, {
    tableNames: { ...tableNames, fences: undefined },
  });
}

/** Derives `backend` so every transaction it opens is advisory-lock-only. */
export function advisoryOnlyBackend<TBackend extends GraphBackend>(
  backend: TBackend,
): TBackend {
  const overrides: Pick<GraphBackend, "transaction"> = {
    transaction: (run, options) =>
      backend.transaction(
        (transaction) => run(withoutFenceRow(transaction)),
        options,
      ),
  };
  return deriveBackend<GraphBackend>(backend, overrides) as TBackend;
}
