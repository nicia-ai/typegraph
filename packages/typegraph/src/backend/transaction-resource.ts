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
 *    holds a given serialized resource, and at most one holds a transactional
 *    SQLite backend object even when its resource is declared independent. The
 *    second stream is refused with the holder's kind named (see
 *    {@link acquireSerializedStreamLease}). Refcounting admitted the two
 *    same-kind rows above, which then failed on the driver after chunks had
 *    already committed.
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
 * - RESIDUAL GAP: an export without interactive transactions abstains entirely — it opens no
 *   snapshot transaction, so `exportGraphStream` neither claims the lease nor
 *   consults it: such an export is never refused and never refuses anyone.
 *   A streaming import claims the lease whatever its backend reports,
 *   because its writes still have to land somewhere an open snapshot is not.
 *   The visible cost of that asymmetry is one conservative refusal: two
 *   streaming imports through a MARKED but deliberately `transactionMode:
 *   "none"` connection frame nothing and would in fact interleave harmlessly,
 *   yet the second is refused. That is the deliberate trade — the alternative
 *   (gating the import's claim on `capabilities.execution.interactiveTransactions` too) would stop a
 *   real snapshot export from being refused mid-import on a mixed-profile
 *   connection, which is the far likelier pairing.
 * - RESIDUAL GAP: the lease's population is INTERCHANGE STREAMS. Ordinary
 *   long-lived frames on the same serialized connection — a `store.transaction`
 *   held across awaits by application code, `schemaWriteTransaction` (the
 *   provenance claim, the identity DDL fence), `store.evolve()` — neither hold
 *   nor consult it, so one of those opening while an export snapshot is live
 *   on the same connection blocks or wedges without a typed error, exactly as
 *   any two of them always have. Representing every long-lived frame here is a
 *   different, larger contract (a connection-wide frame lease); the streams
 *   are covered because they are the pairing users actually compose.
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
 * - `pg` / neon-serverless `Pool` capped at one connection — same site, via
 *   `isSingleConnectionPgPool`, which asks `isSingleConnectionPgPoolCap` what a
 *   cap of one looks like. pg-pool normalizes `max` (and the legacy `poolSize`)
 *   into `options` without coercing either, so `{ max: 1 }`, `{ max: "1" }` and
 *   `{ poolSize: "1" }` are one and the same one-connection pool, and all three
 *   are marked.
 * - postgres-js capped at one connection — same site, via
 *   `isSingleConnectionCallablePgClient`, which asks
 *   `isSingleConnectionPostgresJsCap`. The client is CALLABLE, so it needed a
 *   resolver arm of its own; `begin` reserves the sole connection, making an
 *   export snapshot hold the connection every other wrapper writes through.
 *   postgres-js resolves `max` from the options object, the URL query string and
 *   `PGMAX` and coerces none of them, so `{ max: 1 }`, `?max=1` and `PGMAX=1`
 *   are all marked. Requires postgres-js identity (`isPostgresJsClient`) as well
 *   as the cap: a cap on a callable we cannot attribute to a known driver is not
 *   evidence.
 * - Cloudflare Durable Object storage (`drizzle(ctx.storage)`) —
 *   `createSqliteBackend` via `getDurableObjectStorageClient`, the same
 *   full-shape evidence `transactionMode: "do-sqlite"` requires to run a
 *   transaction. The storage transaction frame is AMBIENT on the storage object
 *   (no tx handle exists on DO), so a second wrapper's writes land inside the
 *   first wrapper's export snapshot; nothing else abstains, since the DO backend
 *   reports `capabilities.execution.interactiveTransactions: true`.
 *
 * DELIBERATELY UNMARKED, by class — marking these would refuse work that
 * succeeds:
 *
 * - Pooled connections: a default-size `pg` / neon-serverless / `@vercel/postgres`
 *   pool, postgres-js or Bun `SQL` at default size. Each checkout is an
 *   independent connection.
 * - Session-less HTTP drivers: `neon-http`, Cloudflare D1, RDS Data API. Nothing
 *   is held between statements, and the two that report
 *   `capabilities.execution.interactiveTransactions: false` are additionally short-circuited by
 *   {@link snapshotExportContention} before marking is consulted.
 * - Remote `@libsql/client` (`http` / `ws`): an independent stream per
 *   transaction.
 * - Separate handles on one database (two `pg` Clients at one server, two
 *   better-sqlite3 handles on one file): genuinely concurrent connections.
 * - Transaction-scoped backends (`transaction()`, `adoptTransaction`): the
 *   caller's transaction already owns the connection and opens no second frame,
 *   and the guards run on the root backend a Store holds. Decorators over a root
 *   backend DO carry the verdict, via
 *   {@link carryBackendResourceAudit}.
 *
 * KNOWN GAPS — serialized in fact, unmarked, so they keep only the
 * identity-based pre-flight in `importGraphStream` (which a `history: true`
 * store's overlay already defeats). Each is a coverage extension needing
 * positive evidence of the client shape, never a silent no-op. Every one of
 * them has the SAME sanctioned workaround until its shape is recognized: the
 * caller declares the connection with
 * `{ serializedResource: { mode: "shared", resource: client } }` (see
 * {@link SerializedResourceDeclaration}), which is a claim the caller can make
 * and this package cannot.
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
 * - postgres-js given a NON-NUMERIC string cap other than one, e.g.
 *   `postgres(url + "?max=5")`: `[...Array(options.max)]` (postgres@3.4.9
 *   `src/index.js:65`) yields length 1 for any such string, so that client
 *   really does open exactly one connection today and really can wedge a stream
 *   pair. Unmarked on purpose — marking it would be marking on an upstream bug,
 *   and the day postgres-js coerces `max` the same configuration becomes a
 *   five-connection pool whose concurrent work we would then refuse. A caller on
 *   that shape materializes the export or imports into an independent backend,
 *   exactly as before this guard existed.
 * - Bun `SQL` (Postgres) built with `{ max: 1 }`: genuinely serialized, but
 *   nothing in this package positively identifies that driver — there is no
 *   Postgres equivalent of the SQLite driver shapes above — so `options.max`
 *   there cannot be attributed to a driver whose dispatch we know. Marking it
 *   needs a Bun-`SQL` discriminator first. Remaining #434 scope.
 * - Drivers we cannot identify at all (`sqlite-proxy`, `pg-proxy`, a bespoke
 *   adapter): whether the far side serializes is unknowable from here, so they
 *   fall under the residual gap above.
 */
import { ConfigurationError } from "../errors";
import { type GraphBackend } from "./types";

/**
 * What we know about the connection a backend's statements land on.
 *
 * `independent` is a POSITIVE verdict — a factory looked and found statements
 * that can run on independent connections. It is not the same runtime state as
 * a backend nobody audited, which carries no record at all.
 */
export type BackendResourceAudit =
  | Readonly<{ kind: "serialized"; resource: object }>
  | Readonly<{
      kind: "independent";
      /** Stable key for the SQLite identity arm of an explicit declaration. */
      identityLeaseResource?: object;
    }>;

/**
 * Declare the connection this backend serializes on, when TypeGraph cannot
 * detect it (Bun `SQL`, `expo-sqlite`, `op-sqlite`, `sqlite-proxy`, `pg-proxy`,
 * a postgres-js pool capped through a string the driver does not coerce — the
 * KNOWN GAPS in this module's inventory). Two wrappers that pass the same
 * object are treated as one serialized resource, exactly as two wrappers over a
 * detected client are.
 *
 * - `"detect"` (the default, and the same behavior as omitting the option):
 *   whatever the factory's driver predicates find, and nothing else.
 * - `"shared"`: the given object IS the serialized resource. Refused with a
 *   {@link ConfigurationError} when the factory detected a DIFFERENT resource —
 *   silently overriding would let two wrappers over one handle be given two
 *   different sentinels and quietly de-serialize a pair that really does share.
 * - `"independent"`: statements can run on independent connections. The
 *   documented escape hatch for a mis-detection, so a user surprised by a
 *   refusal is never stuck.
 *
 * SCOPE — read this before using `"independent"`: this option controls the
 * SHARED-RESOURCE arm of {@link snapshotExportContention} only. It cannot lift
 * the object-identity arm, under which ONE SQLite backend object exporting into
 * ITSELF is refused with `same-sqlite-backend`. That arm is a driver fact (one
 * handle, one open snapshot transaction), not a claim about connection
 * topology, so no declaration can make it false.
 *
 * That surviving arm is SQLITE-ONLY, deliberately: it is gated on
 * `dialect === "sqlite"`, so on Postgres a backend declared `"independent"`
 * exporting into ITSELF is not refused either — a Postgres client that hands
 * out independent connections is exactly what the declaration claims, and the
 * snapshot and the writes it contends with land on different ones.
 */
export type SerializedResourceDeclaration =
  | Readonly<{ mode: "detect" }>
  | Readonly<{ mode: "shared"; resource: object }>
  | Readonly<{ mode: "independent" }>;

const BACKEND_RESOURCE_AUDITS = new WeakMap<object, BackendResourceAudit>();

/**
 * The kinds of long-lived interchange stream that hold a serialized connection
 * across many statements — the population the lease is exclusive over.
 */
export type SerializedStreamKind = "export-snapshot" | "import-stream";

/**
 * The outcome of claiming a serialized resource for a long-lived stream: the
 * (idempotent) release and the resource the claim was registered under when it
 * succeeded, or the kind of stream already holding it when it did not.
 *
 * `resource` is the decision itself rather than a flag a caller re-derives
 * from the backend: `undefined` means nothing was registered, because the
 * backend runs on no known serialized resource.
 */
export type SerializedStreamLease =
  | Readonly<{
      acquired: true;
      resource: object | undefined;
      release: () => void;
    }>
  | Readonly<{ acquired: false; heldBy: SerializedStreamKind }>;

/**
 * The one long-lived stream holding each serialized resource. An entry exists
 * only while that stream is in flight; its release deletes the key, so a
 * finished stream retains nothing and refuses nobody.
 */
const ACTIVE_SERIALIZED_STREAMS = new Map<object, SerializedStreamKind>();

/** Whether two audits are the same verdict about the same connection. */
function auditsAgree(
  left: BackendResourceAudit,
  right: BackendResourceAudit,
): boolean {
  if (left.kind === "serialized") {
    return right.kind === "serialized" && left.resource === right.resource;
  }
  return (
    right.kind === "independent" &&
    left.identityLeaseResource === right.identityLeaseResource
  );
}

/** Names a verdict for the write-once refusal below. */
function formatAudit(audit: BackendResourceAudit): string {
  return audit.kind === "serialized" ? "serialized" : "independent";
}

/**
 * The two objects a refused `"shared"` declaration could not reconcile: the one
 * the caller named and the one this package detected.
 */
export type SerializedResourceConflict = Readonly<{
  declared: object;
  detected: object;
}>;

/**
 * The handles behind each refusal, held OFF the error object on purpose.
 *
 * `TypeGraphError.toLogString()` `JSON.stringify`s `details`, and the
 * documented handler pattern is `console.error(error.toLogString())` — so a
 * driver handle in `details` writes whatever that driver stores into the
 * caller's logs, and a `pg.Pool` stores its `connectionString`, password
 * included. The refusal therefore carries only a DESCRIPTION of each side
 * (`declaredKind` / `detectedKind`), while the identities live here, reachable
 * by asking for them and by nothing that walks an error's own properties.
 */
const SERIALIZED_RESOURCE_CONFLICTS = new WeakMap<
  Error,
  SerializedResourceConflict
>();

/**
 * The two objects a serialized-resource refusal could not reconcile, or
 * `undefined` for any other error.
 *
 * @internal
 */
export function serializedResourceConflict(
  error: unknown,
): SerializedResourceConflict | undefined {
  return error instanceof ConfigurationError ?
      SERIALIZED_RESOURCE_CONFLICTS.get(error)
    : undefined;
}

/**
 * How a refusal names one side of a conflict without publishing the handle:
 * the constructor name (`"Database"`, `"BoundPool"`, `"Object"`), which says
 * what KIND of thing each side is and carries no connection string.
 */
function describeSerializedResource(resource: object): string {
  const constructorName = (
    resource as Readonly<{ constructor?: Readonly<{ name?: unknown }> }>
  ).constructor?.name;
  return typeof constructorName === "string" && constructorName !== "" ?
      constructorName
    : "Object";
}

/**
 * The verdict a backend factory records, from what its driver predicates
 * detected and what the caller declared.
 *
 * The single owner of "what a {@link SerializedResourceDeclaration} means":
 * both drizzle factories call it, so the two cannot drift about whether a
 * declaration wins, loses, or is refused.
 *
 * Applied or refused, never ignored:
 *
 * - `"shared"` naming the resource detection already found, or naming one on a
 *   backend detection could not classify → recorded as that resource.
 * - `"shared"` naming a DIFFERENT resource than detection found → refused, so
 *   two wrappers over one handle cannot be handed two different sentinels and
 *   silently de-serialized.
 * - `"independent"` → recorded, whatever detection found. This is the escape
 *   hatch, not a conflict: detection is a duck-type over driver internals and
 *   the caller knows their topology.
 * - `"detect"` or absent → exactly what detection found.
 *
 * Called INSIDE the factory body before the backend object exists, so a
 * refusal happens before any object is published (CTA-3) and a caller can never
 * hold a backend whose declaration was rejected.
 *
 * @throws {ConfigurationError} `details.reason: "serialized-resource-conflict"`
 * when a `"shared"` declaration names a resource detection disagrees with. Its
 * `details` describe the two sides (`declaredKind` / `detectedKind`) rather
 * than carrying them, because `details` is logged verbatim; the handles
 * themselves come from {@link serializedResourceConflict}.
 * @internal
 */
export function resolveDeclaredBackendResource(
  detected: object | undefined,
  declaration: SerializedResourceDeclaration | undefined,
): BackendResourceAudit {
  switch (declaration?.mode) {
    case "shared": {
      if (detected !== undefined && detected !== declaration.resource) {
        const refusal = new ConfigurationError(
          `serializedResource declared { mode: "shared" } naming an object ` +
            `that is not the connection this backend was detected to run on. ` +
            `Two wrappers over one connection must name the SAME object, or ` +
            `the guards that refuse a concurrent export/import pair on it stop ` +
            `seeing them as one resource.`,
          {
            reason: "serialized-resource-conflict",
            declaredKind: describeSerializedResource(declaration.resource),
            detectedKind: describeSerializedResource(detected),
          },
          {
            suggestion:
              `Declare the client TypeGraph already detected (or drop the ` +
              `declaration and let detection stand). Use ` +
              `{ mode: "independent" } if the detection is wrong and this ` +
              `backend really does run on its own connection.`,
          },
        );
        SERIALIZED_RESOURCE_CONFLICTS.set(refusal, {
          declared: declaration.resource,
          detected,
        });
        throw refusal;
      }
      return { kind: "serialized", resource: declaration.resource };
    }
    case "independent": {
      return { kind: "independent", identityLeaseResource: {} };
    }
    case "detect":
    case undefined: {
      return detected === undefined ?
          { kind: "independent" }
        : { kind: "serialized", resource: detected };
    }
  }
}

/**
 * Records what a backend factory found about the connection its backend runs
 * on.
 *
 * INVARIANT: recorded ONCE per backend, by the factory that built it, BEFORE
 * the backend object escapes the factory body. Derived backends (deriveBackend,
 * projectBackend, projectBackendWithout, projectGraphBackend,
 * wrapWithManagedClose) carry the verdict at construction time, so a wrapper
 * built before the audit lands is silently unaudited and evades the
 * import/clone guards.
 *
 * A second call with an equal verdict is a no-op. A second call with a
 * DIFFERENT verdict throws: the stream lease reads this value and closes over
 * the resource it claimed, so a verdict that changes under a live lease
 * de-serializes a pair that really does share a connection.
 *
 * The throw is an INTERNAL invariant assertion — no library path re-audits and
 * a user cannot reach this function — so it is a plain `TypeError` naming both
 * verdicts, matching the repo's internal-assertion spelling (`requireDefined`,
 * src/utils/presence.ts). Deliberately not a `ConfigurationError`: that type is
 * user-category and would route a library bug into user-facing handling.
 *
 * @internal
 */
export function auditBackendResource(
  backend: GraphBackend,
  audit: BackendResourceAudit,
): void {
  const recorded = BACKEND_RESOURCE_AUDITS.get(backend);
  if (recorded !== undefined) {
    if (auditsAgree(recorded, audit)) return;
    throw new TypeError(
      `A backend's serialized-resource audit is written once: this backend ` +
        `was audited "${formatAudit(recorded)}" and a conflicting audit ` +
        `"${formatAudit(audit)}"${
          recorded.kind === "serialized" && audit.kind === "serialized" ?
            " naming a different connection"
          : ""
        } was attempted. The stream lease closes over the resource it claimed, ` +
        `so a verdict that changes under a live lease de-serializes a pair ` +
        `that really does share a connection.`,
    );
  }
  BACKEND_RESOURCE_AUDITS.set(backend, audit);
}

/**
 * Copies a base backend's verdict onto a backend derived from it, or nothing
 * when the base carries none.
 *
 * @internal The construction seam's carry. `src/backend/derive-backend.ts` is
 * the only module allowed to import it.
 */
export function carryBackendResourceAudit(derived: object, base: object): void {
  const audit = BACKEND_RESOURCE_AUDITS.get(base);
  if (audit !== undefined) BACKEND_RESOURCE_AUDITS.set(derived, audit);
}

/**
 * The verdict recorded for `backend`, or `undefined` when nobody audited it.
 *
 * A pure map read: the value is written once at construction, so two reads can
 * never disagree and a lease cannot have its premise changed under it.
 *
 * @internal
 */
export function resolveBackendAudit(
  backend: object,
): BackendResourceAudit | undefined {
  return BACKEND_RESOURCE_AUDITS.get(backend);
}

/**
 * How a backend's connection was classified, as a single value.
 *
 * `"unaudited"` is NOT a verdict about the connection: it says nobody looked.
 * Two populations are legitimately unaudited and always will be —
 * transaction-scoped backends (`transaction()`, `adoptTransaction`), which are
 * built from an operations fragment rather than derived from a root backend,
 * and `GraphBackend`s users implement themselves. So `"unaudited"` on an
 * arbitrary object proves nothing; on a backend one of this package's factories
 * built, or on one derived from such a backend through `derive-backend.ts`, it
 * proves the construction bypassed the seam.
 */
export type BackendResourceProvenance =
  "serialized" | "independent" | "unaudited";

/**
 * The classification of `backend`'s connection — the decision itself rather
 * than a flag every caller re-derives from {@link resolveBackendAudit}.
 *
 * @internal
 */
export function backendResourceProvenance(
  backend: object,
): BackendResourceProvenance {
  return resolveBackendAudit(backend)?.kind ?? "unaudited";
}

/** Whether two backend wrappers cannot make snapshot reads and writes concurrently. */
export function sharesSerializedTransactionResource(
  left: GraphBackend,
  right: GraphBackend,
): boolean {
  const leftAudit = resolveBackendAudit(left);
  if (leftAudit?.kind !== "serialized") return false;
  const rightAudit = resolveBackendAudit(right);
  // Resource identity, not audit-record identity: two audits naming the same
  // client object are the same connection however they were recorded.
  return (
    rightAudit?.kind === "serialized" &&
    leftAudit.resource === rightAudit.resource
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
 * - A source without interactive transactions (SQLite `transactionMode: "none"`, HTTP-only
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
  if (!source.capabilities.execution.interactiveTransactions) return undefined;
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
 * A known serialized resource is the normal lease key. A transactional SQLite
 * backend audited `independent` instead uses its own identity: the declaration
 * can separate distinct wrappers, but cannot make two streams on ONE backend
 * object use different handles. An unaudited backend, and an independent
 * Postgres backend, registers nothing (see the residual gap in the module doc).
 *
 * The acquired arm reports the resource it registered under, so a caller reads
 * the decision instead of re-deriving it from the backend; `undefined` is the
 * no-op arm. The returned release is idempotent and deletes only its own
 * registration, so an already-released stream can never evict the next
 * stream's lease.
 */
function streamLeaseResource(backend: GraphBackend): object | undefined {
  const audit = resolveBackendAudit(backend);
  if (audit?.kind === "serialized") return audit.resource;
  if (
    audit?.kind === "independent" &&
    audit.identityLeaseResource !== undefined &&
    backend.dialect === "sqlite" &&
    backend.capabilities.execution.interactiveTransactions
  ) {
    return audit.identityLeaseResource;
  }
  return undefined;
}

export function acquireSerializedStreamLease(
  backend: GraphBackend,
  kind: SerializedStreamKind,
): SerializedStreamLease {
  const resource = streamLeaseResource(backend);
  if (resource === undefined) {
    return {
      acquired: true,
      resource: undefined,
      release: () => {
        // Nothing was registered: this backend has no known serialized
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
    resource,
    release: () => {
      if (released) return;
      released = true;
      ACTIVE_SERIALIZED_STREAMS.delete(resource);
    },
  };
}
