/**
 * Ownership tracking for backends that serialize every statement onto ONE
 * database connection.
 *
 * Three facts are recorded here, and only these three:
 *
 * 1. **Which serialized resource a backend wrapper belongs to.** Distinct
 *    `GraphBackend` objects (a second `createPostgresBackend(...)` over the same
 *    client, a projection, an overlay, a managed-close wrapper) are not `===`,
 *    yet their statements land on the same connection. Marking a backend with
 *    the underlying client object — and inheriting that mark through every
 *    decorator — makes "these two wrappers cannot run a read transaction and a
 *    write transaction at the same time" answerable.
 *
 *    Only backends whose driver is known to be single-connection are marked;
 *    everything else is deliberately left unmarked, because a pooled connection
 *    hands out an independent connection per checkout and refusing concurrent
 *    work there would refuse legitimate work. The complete classification —
 *    marked, deliberately unmarked, and known gaps — is the inventory at the
 *    bottom of this doc.
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
 * 3. **Whether a serialized resource currently has a streaming import writing
 *    through it.** The mirror image of fact 2: a streaming import commits chunk
 *    after chunk on that one connection for the whole stream, so an export
 *    snapshot opening meanwhile would hold a read transaction the import's next
 *    chunk can never write past. Registering the import makes the SECOND
 *    long-lived stream on a shared resource refusable in whichever order the two
 *    start.
 *
 * Facts 2 and 3 are refcounted leases over the same resource keys, and every
 * holder registers itself in the SAME synchronous section in which it checks the
 * other registry (see {@link beginSerializedSnapshotExport} and
 * {@link beginSerializedImport}). On a single-threaded event loop a check with no
 * `await` before its registration is atomic: two long-lived streams cannot both
 * observe an empty registry, so no interleaving window is left where each waits
 * for the other.
 *
 * None of the three facts is a general concurrency model:
 *
 * - No attempt is made to detect shared connections we cannot see (two `pg`
 *   Clients dialed at the same server, two better-sqlite3 handles on one file).
 *   Those are genuinely independent connections and are correctly not refused.
 * - RESIDUAL GAP: the leases are keyed by serialized resource, so an UNMARKED
 *   backend registers nothing and can hold neither lease. A driver we cannot
 *   positively identify as single-connection therefore keeps exactly today's
 *   protection — the identity-based pre-flight in `importGraphStream`, which
 *   only sees a stream that still names its own source backend — and an
 *   export/import pair interleaved on such a connection can still wedge. Closing
 *   that requires recognizing the driver, not more bookkeeping here.
 *
 * ## Inventory of serialized resources
 *
 * Every `GraphBackend` in this package is built by `createSqliteBackend` or
 * `createPostgresBackend` (the batteries-included factories — local
 * better-sqlite3, libSQL, PGlite — and every decorator go through one of them),
 * so those two factories are the only places a mark is applied, and this list is
 * the whole population. Predicates are named rather than line-cited so the
 * inventory stays greppable as the files move.
 *
 * MARKED — the factory resolves the resource before the backend object exists,
 * so no wrapper can observe it unmarked:
 *
 * - better-sqlite3 `Database` (`prepare` + `pragma`) — `createSqliteBackend` via
 *   `getSerializedSqliteConnection`.
 * - Local `@libsql/client` (`protocol === "file"`: `file:` paths, `:memory:`,
 *   an embedded replica's local file) — same site, via `isLocalLibsqlClient`.
 * - PGlite — `createPostgresBackend` via `getPgliteClient` (`query` +
 *   `dumpDataDir`).
 * - Bare `pg` / `@neondatabase/serverless` `Client`, including a checked-out
 *   `PoolClient` — same site, via `isBarePgClient`.
 * - `pg` / neon-serverless `Pool` whose resolved `options.max === 1` — same
 *   site, via `isSingleConnectionPgPool`. pg-pool normalizes `max` (and the
 *   legacy `poolSize`) into `options`, so every cap that pool honors is visible
 *   there.
 * - postgres-js built with `{ max: 1 }` — same site, via
 *   `isSingleConnectionCallablePgClient`. The client is CALLABLE, so it needed a
 *   resolver arm of its own; `begin` reserves the sole connection, making an
 *   export snapshot hold the connection every other wrapper writes through.
 *   Requires postgres-js identity (`isPostgresJsClient`) as well as the cap: a
 *   cap on a callable we cannot attribute to a known driver is not evidence.
 * - Cloudflare Durable Object storage (`drizzle(ctx.storage)`) —
 *   `createSqliteBackend` via `getDurableObjectStorageClient`, the same
 *   full-shape evidence `transactionMode: "do-sqlite"` requires to run a
 *   transaction. The storage transaction frame is AMBIENT on the storage object
 *   (no tx handle exists on DO), so a second wrapper's writes land inside the
 *   first wrapper's export snapshot; nothing else abstains, since the DO backend
 *   reports `capabilities.transactions: true`.
 *
 * DELIBERATELY UNMARKED, by class — marking these would refuse work that
 * succeeds:
 *
 * - Pooled connections: a default-size `pg` / neon-serverless / `@vercel/postgres`
 *   pool, postgres-js or Bun `SQL` at default size. Each checkout is an
 *   independent connection.
 * - Session-less HTTP drivers: `neon-http`, Cloudflare D1, RDS Data API. Nothing
 *   is held between statements, and the two that report
 *   `capabilities.transactions: false` are additionally short-circuited by
 *   {@link snapshotExportContention} before marking is consulted.
 * - Remote `@libsql/client` (`http` / `ws`): an independent stream per
 *   transaction.
 * - Separate handles on one database (two `pg` Clients at one server, two
 *   better-sqlite3 handles on one file): genuinely concurrent connections.
 * - Transaction-scoped backends (`transaction()`, `adoptTransaction`): the
 *   caller's transaction already owns the connection and opens no second frame,
 *   and the guards run on the root backend a Store holds. Decorators over a root
 *   backend DO carry the mark, via
 *   {@link inheritSerializedTransactionResource}.
 *
 * KNOWN GAPS — serialized in fact, unmarked, so they keep only the
 * identity-based pre-flight in `importGraphStream` (which a `history: true`
 * store's overlay already defeats). Each is a coverage extension needing
 * positive evidence of the client shape, never a silent no-op:
 *
 * - Single-connection SQLite drivers other than better-sqlite3 and local libSQL
 *   — bun:sqlite, sql.js, expo-sqlite, op-sqlite, node:sqlite. One synchronous
 *   connection each, but none exposes better-sqlite3's `pragma`, so the
 *   duck-type cannot see them. #434 names bun:sqlite and node:sqlite; the rest
 *   are the same class.
 * - Bun `SQL` (Postgres) built with `{ max: 1 }`: genuinely serialized, but
 *   nothing in this package positively identifies that driver — the SQLite side
 *   recognizes `BunSQLiteSession`, and there is no Postgres equivalent — so
 *   `options.max` there cannot be attributed to a driver whose dispatch we know.
 *   Marking it needs a Bun-`SQL` discriminator first. Remaining #434 scope.
 * - Drivers we cannot identify at all (`sqlite-proxy`, `pg-proxy`, a bespoke
 *   adapter): whether the far side serializes is unknowable from here, so they
 *   fall under the residual gap above.
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
 * Counts the streaming imports currently writing through each serialized
 * resource, with the same lifecycle as {@link ACTIVE_SNAPSHOT_EXPORTS}.
 */
const ACTIVE_STREAMING_IMPORTS = new Map<object, number>();

/**
 * The refcount both leases share: register `backend`'s serialized resource in
 * `leases` and return the (idempotent) release.
 *
 * Unmarked backends get a no-op: without a known serialized resource there is
 * no shared connection for the other side to be refused against.
 */
function acquireResourceLease(
  leases: Map<object, number>,
  backend: GraphBackend,
): () => void {
  const resource = SERIALIZED_TRANSACTION_RESOURCES.get(backend);
  if (resource !== undefined) {
    leases.set(resource, (leases.get(resource) ?? 0) + 1);
  }
  let released = false;
  return () => {
    if (released || resource === undefined) return;
    released = true;
    const remaining = (leases.get(resource) ?? 1) - 1;
    if (remaining <= 0) {
      leases.delete(resource);
      return;
    }
    leases.set(resource, remaining);
  };
}

/** Whether any holder has `leases` open on the resource `backend` runs on. */
function hasResourceLease(
  leases: Map<object, number>,
  backend: GraphBackend,
): boolean {
  const resource = SERIALIZED_TRANSACTION_RESOURCES.get(backend);
  if (resource === undefined) return false;
  return (leases.get(resource) ?? 0) > 0;
}

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
 * CALL CONTRACT: the caller must check {@link hasActiveSerializedImport} and call
 * this with NO `await` in between, so the pair is one atomic section against a
 * concurrently starting import.
 */
export function beginSerializedSnapshotExport(
  backend: GraphBackend,
): () => void {
  return acquireResourceLease(ACTIVE_SNAPSHOT_EXPORTS, backend);
}

/**
 * Whether an export snapshot transaction is open on the serialized resource
 * `backend` writes through — from ANY backend wrapper over that resource, and
 * regardless of how the export's chunk stream reached its consumer.
 */
export function hasActiveSerializedSnapshotExport(
  backend: GraphBackend,
): boolean {
  return hasResourceLease(ACTIVE_SNAPSHOT_EXPORTS, backend);
}

/**
 * Records that a streaming import is writing through `backend`'s serialized
 * resource and returns the (idempotent) release for when the chunk loop ends.
 *
 * CALL CONTRACT: the caller must check {@link hasActiveSerializedSnapshotExport}
 * and call this with NO `await` in between — that is what makes "no export
 * snapshot was open when this import claimed the connection" true for the whole
 * import rather than only at the instant it was observed.
 *
 * The import's own chunk transactions run on this same connection and are not
 * exports, so the lease never conflicts with the import that holds it.
 */
export function beginSerializedImport(backend: GraphBackend): () => void {
  return acquireResourceLease(ACTIVE_STREAMING_IMPORTS, backend);
}

/**
 * Whether a streaming import is writing through the serialized resource
 * `backend` reads from — from ANY backend wrapper over that resource.
 */
export function hasActiveSerializedImport(backend: GraphBackend): boolean {
  return hasResourceLease(ACTIVE_STREAMING_IMPORTS, backend);
}
