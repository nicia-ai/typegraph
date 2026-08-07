/**
 * Ownership tracking for backends that serialize every statement onto ONE
 * database connection.
 *
 * Two facts are recorded here, and only these two:
 *
 * 1. **Which serialized resource a backend wrapper belongs to.** Distinct
 *    `GraphBackend` objects (a second `createPostgresBackend(...)` over the same
 *    client, a projection, an overlay, a managed-close wrapper) are not `===`,
 *    yet their statements land on the same connection. Marking a backend with
 *    the underlying client object — and inheriting that mark through every
 *    decorator — makes "these two wrappers cannot run a read transaction and a
 *    write transaction at the same time" answerable.
 *
 *    Only backends whose driver is known to be single-connection are marked
 *    (PGlite, a bare `pg` Client, an explicitly `max: 1` pool, a better-sqlite3
 *    `Database`). Everything else is deliberately left unmarked: a pooled
 *    connection hands out an independent connection per checkout, so refusing
 *    concurrent work there would refuse legitimate work.
 *
 * 2. **Whether a serialized resource currently has an export snapshot
 *    transaction open on it.** A streaming export holds a read-only transaction
 *    on its connection for the whole stream. Any write issued on that same
 *    connection meanwhile either lands inside the read-only transaction or waits
 *    for a connection that is never released — so an import into a resource with
 *    an active export snapshot is refused regardless of which object the caller
 *    passes, including a user-wrapped stream that no longer identifies its
 *    source backend.
 *
 * Neither fact is a general concurrency model: no attempt is made to detect
 * shared connections we cannot see (two `pg` Clients dialed at the same server,
 * two better-sqlite3 handles on one file). Those are genuinely independent
 * connections and are correctly not refused.
 */
import { type GraphBackend } from "./types";

const SERIALIZED_TRANSACTION_RESOURCES = new WeakMap<object, object>();

/**
 * Counts the export snapshot transactions currently open on each serialized
 * resource. An entry exists only while at least one export is in flight; the
 * final release deletes the key, so a completed export retains nothing.
 */
const ACTIVE_SNAPSHOT_EXPORTS = new Map<object, number>();

/**
 * Marks backends whose distinct wrappers still serialize on one connection.
 *
 * INVARIANT: a backend factory must call this before anything can wrap the
 * backend it built. Decorators (createBackendOverlay, wrapWithManagedClose,
 * projections) copy the mark at construction time, so a wrapper built before
 * the mark lands is silently unowned and evades the import/clone guards.
 */
export function markSerializedTransactionResource(
  backend: GraphBackend,
  resource: object,
): void {
  SERIALIZED_TRANSACTION_RESOURCES.set(backend, resource);
}

/** Preserves serialized-resource ownership when decorating a backend. */
export function inheritSerializedTransactionResource(
  target: object,
  source: object,
): void {
  const resource = SERIALIZED_TRANSACTION_RESOURCES.get(source);
  if (resource !== undefined) {
    SERIALIZED_TRANSACTION_RESOURCES.set(target, resource);
  }
}

/** Whether two backend wrappers cannot make snapshot reads and writes concurrently. */
export function sharesSerializedTransactionResource(
  left: GraphBackend,
  right: GraphBackend,
): boolean {
  const leftResource = SERIALIZED_TRANSACTION_RESOURCES.get(left);
  return (
    leftResource !== undefined &&
    leftResource === SERIALIZED_TRANSACTION_RESOURCES.get(right)
  );
}

/** How a snapshot export on one backend contends with a write on another. */
export type SnapshotExportContention =
  "same-sqlite-backend" | "shared-resource";

/**
 * Whether a snapshot export on `source` would hold the one connection `target`
 * writes through, and via which detector. `undefined` means no contention.
 *
 * The single owner of "a snapshot export blocks this write": the streaming
 * import guard, and the working-copy cloner that exists to pre-empt it, both
 * ask here rather than re-deriving the arms.
 *
 * - A `transactions: false` source (SQLite `transactionMode: "none"`, HTTP-only
 *   Postgres drivers) exports statement by statement with nothing held open, so
 *   sharing its connection is merely interleaving and is never contention.
 * - Object identity on a SQLite backend is checked FIRST, so a marked
 *   better-sqlite3 backend exporting into itself reports the more specific
 *   detector even though the shared-resource arm would also match.
 */
export function snapshotExportContention(
  source: GraphBackend,
  target: GraphBackend,
): SnapshotExportContention | undefined {
  if (!source.capabilities.transactions) return undefined;
  if (source === target && source.dialect === "sqlite") {
    return "same-sqlite-backend";
  }
  if (sharesSerializedTransactionResource(source, target)) {
    return "shared-resource";
  }
  return undefined;
}

/**
 * Records that an export snapshot transaction is open on `backend`'s serialized
 * resource and returns the (idempotent) release for when it closes.
 *
 * Unmarked backends get a no-op: without a known serialized resource there is
 * nothing an import could be refused against.
 */
export function beginSerializedSnapshotExport(
  backend: GraphBackend,
): () => void {
  const resource = SERIALIZED_TRANSACTION_RESOURCES.get(backend);
  if (resource !== undefined) {
    ACTIVE_SNAPSHOT_EXPORTS.set(
      resource,
      (ACTIVE_SNAPSHOT_EXPORTS.get(resource) ?? 0) + 1,
    );
  }
  let released = false;
  return () => {
    if (released || resource === undefined) return;
    released = true;
    const remaining = (ACTIVE_SNAPSHOT_EXPORTS.get(resource) ?? 1) - 1;
    if (remaining <= 0) {
      ACTIVE_SNAPSHOT_EXPORTS.delete(resource);
      return;
    }
    ACTIVE_SNAPSHOT_EXPORTS.set(resource, remaining);
  };
}

/**
 * Whether an export snapshot transaction is open on the serialized resource
 * `backend` writes through — from ANY backend wrapper over that resource, and
 * regardless of how the export's chunk stream reached its consumer.
 */
export function hasActiveSerializedSnapshotExport(
  backend: GraphBackend,
): boolean {
  const resource = SERIALIZED_TRANSACTION_RESOURCES.get(backend);
  if (resource === undefined) return false;
  return (ACTIVE_SNAPSHOT_EXPORTS.get(resource) ?? 0) > 0;
}
