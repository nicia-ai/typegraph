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
 *    Only backends whose driver is known to be single-connection are marked;
 *    everything else is deliberately left unmarked, because a pooled connection
 *    hands out an independent connection per checkout and refusing concurrent
 *    work there would refuse legitimate work. The complete classification —
 *    marked, deliberately unmarked, and known gaps — is the inventory at the
 *    bottom of this doc.
 *
 * 2. **Which long-lived interchange stream currently holds that resource.** A
 *    streaming export holds a read-only transaction on its connection for the
 *    whole stream; a streaming import opens a write transaction per chunk on
 *    that same connection for the whole stream. Any second long-lived stream on
 *    the resource therefore either nests a transaction inside the first one
 *    (`cannot start a transaction within a transaction`) or waits for a
 *    connection that is never released — and that is true of ALL FOUR pairings,
 *    not only the two cross-kind ones:
 *
 *    | holder          | second stream    | outcome without the lease          |
 *    | --------------- | ---------------- | ---------------------------------- |
 *    | export snapshot | import stream    | import's chunk waits on the reader |
 *    | import stream   | export snapshot  | export's read strands the import   |
 *    | import stream   | import stream    | nested BEGIN                       |
 *    | export snapshot | export snapshot  | nested BEGIN                       |
 *
 *    So the lease is EXCLUSIVE, not refcounted: at most one stream of any kind
 *    holds a given serialized resource, and the second one is refused with the
 *    holder's kind named (see {@link acquireSerializedStreamLease}). Refcounting
 *    admitted the two same-kind rows above, which then failed on the driver
 *    after chunks had already committed.
 *
 *    `"import-stream"` is the kind of EVERY long-lived import, not only the
 *    chunk-streaming one: an in-memory `importGraph` and a `trustedImport`
 *    session write through the same one connection over the same kind of window,
 *    so they claim the same lease and are refused by the same holders.
 *
 * The check and the registration happen in ONE synchronous section inside
 * {@link acquireSerializedStreamLease} — there is no way for a caller to check
 * without claiming, so there is no window to get wrong. On a single-threaded
 * event loop a check with no `await` before its registration is atomic: two
 * long-lived streams cannot both observe a free resource, so no interleaving is
 * left where each waits for the other.
 *
 * Neither fact is a general concurrency model:
 *
 * - No attempt is made to detect shared connections we cannot see (two `pg`
 *   Clients dialed at the same server, two better-sqlite3 handles on one file).
 *   Those are genuinely independent connections and are correctly not refused.
 * - RESIDUAL GAP: the lease is keyed by serialized resource, so an UNMARKED
 *   backend registers nothing and can hold nothing. A driver we cannot
 *   positively identify as single-connection therefore keeps exactly today's
 *   protection — the identity-based pre-flight in `importGraphStream`, which
 *   only sees a stream that still names its own source backend — and an
 *   export/import pair interleaved on such a connection can still wedge. Closing
 *   that requires recognizing the driver, not more bookkeeping here.
 * - RESIDUAL GAP: a `transactions: false` export abstains entirely — it opens no
 *   snapshot transaction, so `exportGraphStream` neither claims the lease nor
 *   consults it: such an export is never refused and never refuses anyone.
 *   A streaming import claims the lease whatever its backend reports,
 *   because its writes still have to land somewhere an open snapshot is not.
 *   The visible cost of that asymmetry is one conservative refusal: two
 *   streaming imports through a MARKED but deliberately `transactionMode:
 *   "none"` connection frame nothing and would in fact interleave harmlessly,
 *   yet the second is refused. That is the deliberate trade — the alternative
 *   (gating the import's claim on `capabilities.transactions` too) would stop a
 *   real snapshot export from being refused mid-import on a mixed-profile
 *   connection, which is the far likelier pairing.
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
 *   `getSerializedSqliteConnection`, which asks one named predicate per driver.
 * - bun:sqlite `Database` (`prepare` + `query` + `run`/`exec` + `serialize` +
 *   a `filename` string) — same site, via `isBunSqliteClient`. One synchronous
 *   connection, like better-sqlite3; `query` and `filename` are what separate
 *   it structurally from better-sqlite3 (`pragma`, `name`), so the mark never
 *   rests on a session's constructor name, which bundlers rename.
 * - sql.js `Database` (`prepare` + `exec` + `run` + `export` +
 *   `getRowsModified`) — same site, via `isSqlJsClient`. One in-WASM handle
 *   executed in-process; `export` and `getRowsModified` are sql.js's own API
 *   and exist on no other SQLite client.
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
 * - React Native / Expo SQLite drivers — `expo-sqlite` and `op-sqlite`. One
 *   connection each, and both are genuinely serialized, but neither exposes a
 *   plain `prepare` (`prepareAsync` / `prepareSync`, `prepareStatement`), so
 *   none of the predicates above can see them and neither driver is installable
 *   here to derive the shape from rather than guess it. Remaining #434 scope:
 *   each needs its own positive shape, taken from the driver's own typings.
 * - `node:sqlite` `DatabaseSync`: UNREACHABLE through Drizzle today —
 *   drizzle-orm 0.45.2 ships `bun-sqlite`, `sql-js`, `durable-sqlite`,
 *   `expo-sqlite`, `op-sqlite`, `sqlite-proxy` and `better-sqlite3`, and no
 *   `node-sqlite` entrypoint, so no `createSqliteBackend` call can be handed
 *   one. Re-check when the Drizzle floor moves; nothing to mark until then.
 * - Bun `SQL` (Postgres) built with `{ max: 1 }`: genuinely serialized, but
 *   nothing in this package positively identifies that driver — there is no
 *   Postgres equivalent of the SQLite driver shapes above — so `options.max`
 *   there cannot be attributed to a driver whose dispatch we know. Marking it
 *   needs a Bun-`SQL` discriminator first. Remaining #434 scope.
 * - Drivers we cannot identify at all (`sqlite-proxy`, `pg-proxy`, a bespoke
 *   adapter): whether the far side serializes is unknowable from here, so they
 *   fall under the residual gap above.
 */
import { type GraphBackend } from "./types";

const SERIALIZED_TRANSACTION_RESOURCES = new WeakMap<object, object>();

/**
 * The kinds of long-lived interchange stream that hold a serialized connection
 * across many statements — the population the lease is exclusive over.
 */
export type SerializedStreamKind = "export-snapshot" | "import-stream";

/**
 * The outcome of claiming a serialized resource for a long-lived stream: the
 * (idempotent) release when the claim succeeded, or the kind of stream already
 * holding it when it did not.
 */
export type SerializedStreamLease =
  | Readonly<{ acquired: true; release: () => void }>
  | Readonly<{ acquired: false; heldBy: SerializedStreamKind }>;

/**
 * The one long-lived stream holding each serialized resource. An entry exists
 * only while that stream is in flight; its release deletes the key, so a
 * finished stream retains nothing and refuses nobody.
 */
const ACTIVE_SERIALIZED_STREAMS = new Map<object, SerializedStreamKind>();

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
 * Claims the serialized resource `backend` runs on for a long-lived stream of
 * `kind`, or reports which kind of stream already holds it.
 *
 * EXCLUSIVE: one stream per serialized resource, whatever its kind. Two exports
 * nest their snapshot transactions on the one connection exactly as an export
 * and an import do, so "is a stream already running here" — not "is a stream of
 * the OTHER kind already running here" — is the question the holder registry
 * answers.
 *
 * ONE SYNCHRONOUS SECTION, by construction: the lookup and the registration are
 * in this function's body with no `await` between them, and there is no separate
 * "is it free?" query a caller could read and then act on later. On a
 * single-threaded event loop that makes "no other stream held this connection
 * when this one claimed it" true for the whole stream, in whichever order two
 * streams start — the second one always finds the first's registration.
 *
 * Marked backends only: without a known serialized resource there is no shared
 * connection for anyone to be refused against, so an unmarked backend always
 * acquires and registers nothing (see the residual gap in the module doc).
 *
 * The returned release is idempotent and deletes only its own registration,
 * so an already-released stream can never evict the next stream's lease.
 */
export function acquireSerializedStreamLease(
  backend: GraphBackend,
  kind: SerializedStreamKind,
): SerializedStreamLease {
  const resource = SERIALIZED_TRANSACTION_RESOURCES.get(backend);
  if (resource === undefined) {
    return {
      acquired: true,
      release: () => {
        // Nothing was registered: an unmarked backend has no known serialized
        // resource, so there is nothing to give back.
      },
    };
  }
  const holder = ACTIVE_SERIALIZED_STREAMS.get(resource);
  if (holder !== undefined) return { acquired: false, heldBy: holder };
  ACTIVE_SERIALIZED_STREAMS.set(resource, kind);
  let released = false;
  return {
    acquired: true,
    release: () => {
      if (released) return;
      released = true;
      ACTIVE_SERIALIZED_STREAMS.delete(resource);
    },
  };
}
