/**
 * Index materialization — runs declared index DDL against the live
 * database and tracks per-deployment status in
 * `typegraph_index_materializations`.
 *
 * Reads `IndexDeclaration[]` from `GraphDef.indexes`, generates DDL via
 * `generateIndexDDL`, executes via `backend.executeDdl` (Postgres path
 * uses `CREATE INDEX CONCURRENTLY`, which cannot run inside a
 * transaction — `executeDdl` runs at the top-level backend, never inside
 * `transaction(...)`), and upserts a status row per index.
 *
 * Caveats baked in to the algorithm:
 *
 * - SQL index names are physical, database-global identifiers.
 *   Cross-graph collisions (two graphs declaring the same name with
 *   different shapes) surface as a `failed` result with reason
 *   "signature drift", because the existing recorded signature won't
 *   match the new one.
 * - On Postgres, `CREATE INDEX CONCURRENTLY IF NOT EXISTS` does NOT
 *   prove the existing physical index has the same shape as ours —
 *   only that something with that name exists. Drift detection here
 *   relies on TypeGraph's recorded signature, not on PG metadata.
 * - Failed `CONCURRENTLY` builds leave invalid indexes behind
 *   (`pg_index.indisvalid = false`). Relational rebuilds self-heal: the
 *   claim-holding materializer drops an invalid leftover with the
 *   declaration's name before rebuilding (see dropInvalidIndexLeftover).
 *   Vector per-field index leftovers remain operator-repair.
 * - Two materializers racing the SAME index name serialize through a
 *   durable claim in the status table (see materializeWithClaim) —
 *   concurrent same-name expression-index CIC builds deadlock on
 *   Postgres (no safe-snapshot exemption).
 */

import { sql } from "drizzle-orm";

import { type RawBackend } from "../backend/branded";
import {
  type CreateVectorIndexParams,
  type GraphBackend,
  type IndexMaterializationRow,
  type RecordIndexMaterializationParams,
} from "../backend/types";
import { type GraphDef, isKnownKind } from "../core/define-graph";
import type { IndexEntity } from "../core/types";
import { ConfigurationError, KindNotFoundError } from "../errors";
import { generateIndexDDL } from "../indexes/ddl";
import {
  generateSystemIndexDDL,
  resolveSystemIndexTableName,
  SYSTEM_INDEX_DECLARATIONS,
  type SystemIndexDeclaration,
  systemIndexName,
} from "../indexes/system";
import {
  type IndexDeclaration,
  type RelationalIndexDeclaration,
  type VectorIndexDeclaration,
} from "../indexes/types";
import { sqlValueList } from "../query/compiler/predicate-utils";
import { type SqlDialect } from "../query/dialect/types";
import { asCompiledRowsSql } from "../query/sql-intent";
import { sortedReplacer } from "../schema/canonical";
import { serializeIndexDeclaration } from "../schema/serializer";
import { nowIso } from "../utils/date";
import { sha256Hex } from "../utils/hash";
import {
  ensureFocusedStatusTable,
  runBucketedMaterialization,
} from "./materialize-shared";

/**
 * Cross-caller build claim timing (Postgres).
 *
 * A claim older than the lease is stale (its holder crashed mid-build) and
 * may be taken over; the lease is generous because CREATE INDEX
 * CONCURRENTLY on a large relation legitimately runs for minutes, and a
 * premature takeover would recreate exactly the same-index CIC race the
 * claim exists to prevent. Losers retry the claim on an interval —
 * re-claiming after the winner releases converges through the normal
 * already-materialized check — and give up shortly after the lease bound.
 */
const CLAIM_LEASE_MS = 15 * 60_000;
const CLAIM_RETRY_DELAY_MS = 200;
const CLAIM_WAIT_TIMEOUT_MS = CLAIM_LEASE_MS + 60_000;

/**
 * Whether the backend implements the FULL cross-caller build-claim
 * protocol. One predicate for both decisions that depend on it — build
 * serialization and the post-create statistics refresh — so a backend
 * implementing only half the surface can never refresh without
 * serializing (the combination that reopens the same-index CIC deadlock).
 */
function hasIndexBuildClaimProtocol(backend: GraphBackend): boolean {
  return (
    backend.claimIndexMaterialization !== undefined &&
    backend.releaseIndexMaterializationClaim !== undefined
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export type MaterializeIndexesOptions = Readonly<{
  /** Restrict to indexes whose `kind` is in this set. */
  kinds?: readonly string[];
  /** Stop on the first failure. Default: false (best-effort). */
  stopOnError?: boolean;
  /**
   * Refresh planner statistics (ANALYZE) after at least one index was
   * created. A fresh index can be ignored by the planner until statistics
   * exist. Default: true. Applied on non-concurrent builders (SQLite) and
   * on concurrent builders that serialize same-index builds via the
   * cross-caller claim primitive (the bundled Postgres backend); a custom
   * concurrent backend without the primitive skips the refresh — see
   * refreshStatisticsAfterCreation — and should call
   * `store.refreshStatistics()` after materializing.
   */
  refreshStatistics?: boolean;
}>;

/**
 * Per-index outcome from `materializeIndexes()`.
 *
 * Status values:
 * - `created`: DDL ran successfully and a new physical index now exists.
 * - `alreadyMaterialized`: status table shows a prior successful
 *   materialization with the same signature; no DDL ran.
 * - `failed`: the DDL or status write failed; `error` carries the
 *   captured exception. Best-effort mode continues to the next index;
 *   `stopOnError: true` halts.
 * - `skipped`: the backend can't materialize this index variant in its
 *   current configuration (e.g. vector indexes against SQLite without
 *   sqlite-vec, or `indexType: "none"` declared on an embedding). The
 *   declaration is recognized but intentionally not acted on. Status
 *   table is NOT updated for skipped entries.
 */
export type MaterializeIndexesEntry = Readonly<{
  indexName: string;
  entity: IndexEntity;
  kind: string;
  status: "created" | "alreadyMaterialized" | "failed" | "skipped";
  error?: Error;
  /**
   * Human-readable reason. Required for `skipped`; optional otherwise.
   */
  reason?: string;
}>;

export type MaterializeIndexesResult = Readonly<{
  results: readonly MaterializeIndexesEntry[];
}>;

type MaterializeIndexesContext = Readonly<{
  graph: GraphDef;
  graphId: string;
  // Index DDL runs at the top-level backend (CREATE INDEX CONCURRENTLY cannot
  // run in a transaction) and writes no graph entities — it is the raw seam,
  // not the capture wrapper. Passing the graph-write backend here is an error.
  backend: RawBackend;
  schemaVersion: number;
}>;

export async function materializeIndexes(
  context: MaterializeIndexesContext,
  options: MaterializeIndexesOptions = {},
): Promise<MaterializeIndexesResult> {
  const { graph, graphId, backend, schemaVersion } = context;

  assertBackendSupportsIndexMaterialization(
    backend,
    "store.materializeIndexes()",
  );

  const declared = graph.indexes ?? [];
  const kindFilter =
    options.kinds === undefined ? undefined : new Set(options.kinds);

  if (kindFilter !== undefined) {
    for (const name of kindFilter) {
      if (!isKnownKind(graph, name)) {
        throw new KindNotFoundError(
          name,
          Object.hasOwn(graph.edges, name) ? "edge" : "node",
          {
            graphId,
            suggestion:
              "Only kinds declared on the graph (compile-time or runtime) can be passed to materializeIndexes.",
          },
        );
      }
    }
  }

  const candidates = declared.filter((index) =>
    kindFilter === undefined ? true : kindFilter.has(index.kind),
  );

  // Short-circuit before any I/O when there's nothing to do. The
  // ensure-step below issues a CREATE TABLE statement — paying that
  // cost only to return an empty result is wasteful, especially on
  // repeated `evolve(sameExt, { eager: {} })` calls.
  if (candidates.length === 0) {
    return { results: [] };
  }

  await ensureFocusedStatusTable(
    backend,
    backend.ensureIndexMaterializationsTable,
  );

  const dialect = backend.dialect;
  const tableNames = backend.tableNames;
  const ddlOptions = {
    ifNotExists: true,
    concurrent: dialect === "postgres",
    ...(tableNames?.nodes === undefined ?
      {}
    : { nodesTableName: tableNames.nodes }),
    ...(tableNames?.edges === undefined ?
      {}
    : { edgesTableName: tableNames.edges }),
  } as const;

  // Bulk-preload existing materialization rows for every candidate's
  // status key in one round-trip. With 30 declared indexes this drops 30
  // sequential SELECTs to one. Backends without the bulk primitive fall
  // back to per-key lookups inside `materializeOne`.
  const statusKeys = candidates.map((declaration) =>
    statusKeyFor(declaration, graphId),
  );
  const existingByStatusKey = await preloadMaterializations(
    backend,
    statusKeys,
  );

  // Bulk-preload INVALID index leftovers (interrupted CONCURRENTLY builds)
  // for the relational candidates in one `pg_index` query. On a warm start
  // `settleAgainstExisting` would otherwise fire one leftover check per
  // already-materialized index — the same N-round-trip cost the status
  // preload above just eliminated. Vector entries are excluded: their
  // per-field physical index leftovers are operator-repair, and
  // `settleAgainstExisting` only consults this set for non-vector
  // declarations. Physical names are the declaration names.
  const relationalPhysicalNames = candidates
    .filter((declaration) => declaration.entity !== "vector")
    .map((declaration) => declaration.name);
  const invalidLeftovers = await preloadInvalidIndexLeftovers(
    backend,
    relationalPhysicalNames,
  );

  const materializeEntry = (
    declaration: IndexDeclaration,
  ): Promise<MaterializeIndexesEntry> =>
    declaration.entity === "vector" ?
      materializeVectorIndex(
        declaration,
        backend,
        graphId,
        schemaVersion,
        existingByStatusKey,
        invalidLeftovers,
      )
    : materializeRelationalIndex(
        declaration,
        backend,
        dialect,
        ddlOptions,
        graphId,
        schemaVersion,
        existingByStatusKey,
        invalidLeftovers,
      );

  // Postgres restricts `CREATE INDEX CONCURRENTLY` to one in-flight
  // build per relation, so declarations group by target relation and
  // each group runs sequentially while the groups run in parallel.
  // Typical schemas land in three buckets (nodes, edges, vector
  // embeddings), giving a ~3× round-trip win over fully sequential
  // without ever issuing two CONCURRENTLY builds against the same
  // relation. SQLite ignores the grouping (writes serialize at the
  // engine level either way).
  const results = await runBucketedMaterialization(
    candidates,
    options,
    (declaration) => parallelBucketKey(declaration),
    (declaration) => materializeEntry(declaration),
  );
  await refreshStatisticsAfterCreation(
    backend,
    results,
    options,
    ddlOptions.concurrent,
  );
  return { results };
}

/**
 * Runs ANALYZE once when at least one index was freshly created (unless the
 * caller opted out): the planner can keep seq-scanning past a brand-new
 * index until statistics for it exist.
 *
 * On backends that build with CREATE INDEX CONCURRENTLY, the refresh runs
 * only when the backend also exposes the cross-caller claim primitive
 * (the bundled Postgres backend does): the claim serializes same-index
 * CIC builds, which used to deadlock under the refresh's timing shift
 * (expression-index CIC gets no safe-snapshot exemption). A custom
 * concurrent backend without the primitive keeps the conservative skip
 * and refreshes manually via `store.refreshStatistics()`.
 *
 * Best-effort: by this point the indexes exist and their status rows are
 * recorded, so a failed statistics refresh must not convert that success
 * into a failure — it degrades to a warning.
 */
async function refreshStatisticsAfterCreation(
  backend: RawBackend,
  results: readonly MaterializeIndexesEntry[],
  options: MaterializeIndexesOptions,
  usesConcurrentBuilds: boolean,
): Promise<void> {
  if (options.refreshStatistics === false) return;
  // Concurrent (Postgres) builds were excluded while two callers racing
  // the SAME expression-index CIC could deadlock — the refresh's timing
  // shift made that latent race fire reliably. With the cross-caller
  // claim protocol serializing same-index builds, backends that expose
  // the claim primitive refresh automatically again; a custom concurrent
  // backend without the primitive keeps the conservative skip.
  if (usesConcurrentBuilds && !hasIndexBuildClaimProtocol(backend)) return;
  if (!results.some((entry) => entry.status === "created")) return;
  try {
    await backend.refreshStatistics();
  } catch (error) {
    if (typeof console === "undefined" || typeof console.warn !== "function") {
      return;
    }
    console.warn(
      "[typegraph] materializeIndexes created its indexes but the follow-up " +
        "statistics refresh failed; run store.refreshStatistics() to give " +
        "the planner fresh statistics.",
      error,
    );
  }
}

function parallelBucketKey(declaration: IndexDeclaration): IndexEntity {
  // Vector indexes now target typed per-`(kind, field)` tables rather
  // than one shared table, so distinct vector declarations could in
  // principle build concurrently. They still share one bucket (keyed by
  // the `"vector"` entity) — serializing them is conservative but
  // correct, and keeps Postgres CIC's "one in-flight build per relation"
  // rule trivially satisfied without tracking per-table identity here.
  // Relational node and edge indexes split into their own entity buckets.
  return declaration.entity;
}

async function materializeRelationalIndex(
  declaration: RelationalIndexDeclaration,
  backend: GraphBackend,
  dialect: SqlDialect,
  ddlOptions: Readonly<{
    ifNotExists: boolean;
    concurrent: boolean;
    nodesTableName?: string;
    edgesTableName?: string;
  }>,
  graphId: string,
  schemaVersion: number,
  existingByStatusKey: ReadonlyMap<string, IndexMaterializationRow>,
  invalidLeftovers: ReadonlySet<string>,
): Promise<MaterializeIndexesEntry> {
  // GIN-family methods are PostgreSQL expression GINs; SQLite has no
  // equivalent (its substring-search story is FTS5 fulltext), so the
  // declaration is recognized and intentionally not acted on — same
  // contract as vector indexes on engines without vector support.
  if (declaration.method !== undefined && dialect !== "postgres") {
    return {
      indexName: declaration.name,
      entity: declaration.entity,
      kind: declaration.kind,
      status: "skipped",
      reason:
        `Index method "${declaration.method}" requires PostgreSQL ` +
        `(expression GIN${declaration.method === "trigram" ? " + pg_trgm" : ""}); ` +
        "SQLite serves substring search via FTS5 fulltext instead.",
    };
  }

  const ddl = generateIndexDDL(declaration, dialect, ddlOptions);
  const targetTable =
    declaration.entity === "node" ?
      (ddlOptions.nodesTableName ?? "typegraph_nodes")
    : (ddlOptions.edgesTableName ?? "typegraph_edges");
  const signature = await computeIndexSignature(
    dialect,
    targetTable,
    declaration,
  );
  return materializeOne(declaration, backend, graphId, schemaVersion, {
    statusKey: declaration.name,
    signature,
    driftLabel: "Index",
    run: async () => {
      if (declaration.method === "trigram") {
        // gin_trgm_ops lives in the pg_trgm extension (contrib — present
        // on stock Postgres and the hosted variants). Idempotent, and a
        // permission failure surfaces as this index's `failed` entry.
        await backend.executeDdl!("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
      }
      await backend.executeDdl!(ddl);
    },
    existingByStatusKey,
    physicalRebuildPreload: invalidLeftovers,
  });
}

async function materializeVectorIndex(
  declaration: VectorIndexDeclaration,
  backend: GraphBackend,
  graphId: string,
  schemaVersion: number,
  existingByStatusKey: ReadonlyMap<string, IndexMaterializationRow>,
  invalidLeftovers: ReadonlySet<string>,
): Promise<MaterializeIndexesEntry> {
  // `indexType: "none"` is a declarative opt-out — the declaration
  // carries shape metadata (dimensions, metric) for tooling but the
  // operator has signaled "no automatic index". Surface as `skipped`.
  if (declaration.indexType === "none") {
    return skippedEntry(
      declaration,
      "indexType: 'none' opts out of automatic materialization",
    );
  }

  // Capability check: backends declare vector support via
  // `capabilities.vector` (derived from the active `VectorStrategy`) and
  // expose that strategy as `backend.vectorStrategy`. When either is
  // absent the backend can't act on the declaration — surface as
  // skipped. The `vectorStrategy` check also narrows it to defined for
  // the per-field table-name resolution below.
  const vectorCapability = backend.capabilities.vector;
  if (
    vectorCapability?.supported !== true ||
    backend.createVectorIndex === undefined ||
    backend.vectorStrategy === undefined
  ) {
    return skippedEntry(
      declaration,
      `Backend (${backend.dialect}) does not support vector indexes in its current configuration`,
    );
  }
  // Capability check (per index type): backends advertise the specific
  // index implementations they support (e.g. SQLite + sqlite-vec
  // accepts vectors but no HNSW/IVFFlat — the brute-force scan IS the
  // "index"). Surface unsupported types as skipped so consumers see a
  // clear "this backend can't materialize this declaration" signal
  // instead of a silent no-op masquerading as `created`.
  if (!vectorCapability.indexTypes.includes(declaration.indexType)) {
    return skippedEntry(
      declaration,
      `Backend (${backend.dialect}) does not support index type "${declaration.indexType}" for vector indexes; supported: ${vectorCapability.indexTypes.join(", ") || "(none)"}`,
    );
  }

  // Hash against the strategy's typed per-`(kind, field)` physical table
  // — the storage this declaration's index actually targets. Folding the
  // resolved table name into the signature keeps drift detection honest:
  // if the strategy (and thus the physical table) changes, the recorded
  // signature mismatches and re-materialization is forced.
  const embeddingsTable = backend.vectorStrategy.tableName(
    graphId,
    declaration.kind,
    declaration.fieldPath,
  );
  const signature = await computeIndexSignature(
    backend.dialect,
    embeddingsTable,
    declaration,
  );
  const params: CreateVectorIndexParams = {
    graphId,
    nodeKind: declaration.kind,
    fieldPath: declaration.fieldPath,
    dimensions: declaration.dimensions,
    metric: declaration.metric,
    indexType: declaration.indexType,
    indexParams: {
      m: declaration.indexParams.m,
      efConstruction: declaration.indexParams.efConstruction,
      ...(declaration.indexParams.lists === undefined ?
        {}
      : { lists: declaration.indexParams.lists }),
    },
    concurrent: backend.dialect === "postgres",
  };
  return materializeOne(declaration, backend, graphId, schemaVersion, {
    // Compound status-table key for vector entries. Pgvector creates
    // one physical index per (graphId, kind, field) — so the
    // per-deployment status table needs to disambiguate entries that
    // SHARE a declaration name but belong to different graphs.
    // Applied uniformly to auto-derived AND explicit declarations.
    statusKey: vectorStatusKey(graphId, declaration.name),
    signature,
    driftLabel: "Vector index",
    run: () => backend.createVectorIndex!(params),
    existingByStatusKey,
    physicalRebuildPreload: invalidLeftovers,
  });
}

/**
 * The identity a materialization run needs from its declaration: the
 * physical/status name plus the `(entity, kind)` pair recorded on the
 * status row. Relational and vector declarations satisfy it structurally;
 * system indexes construct it from `SYSTEM_INDEX_DECLARATIONS`.
 */
type MaterializableIndexIdentity = Readonly<{
  name: string;
  entity: IndexEntity;
  kind: string;
}>;

/**
 * Shared "check existing → run → record" frame for relational, vector,
 * and system materialization. All paths track a per-deployment status row
 * keyed by `statusKey`, short-circuit on a matching signature, surface
 * signature drift as a recorded failure, and execute `run()` on first
 * materialization. Differences live entirely in the `MaterializeAction`
 * the caller passes.
 */
async function materializeOne(
  declaration: MaterializableIndexIdentity,
  backend: GraphBackend,
  graphId: string,
  schemaVersion: number,
  action: Readonly<{
    statusKey: string;
    signature: string;
    driftLabel: string;
    run: () => Promise<void>;
    existingByStatusKey: ReadonlyMap<string, IndexMaterializationRow>;
    /**
     * Physical index names whose catalog state requires a rebuild despite
     * a matching success row. Relational: INVALID `CONCURRENTLY`
     * leftovers. System: leftovers plus physically absent indexes —
     * name-presence identifies a system index, so absence is proof the
     * recorded success is stale (dump/restore, manual drop).
     */
    physicalRebuildPreload: ReadonlySet<string>;
    /**
     * Fresh per-name variant of `physicalRebuildPreload` for the
     * post-claim re-check (the preload is stale after waiting on another
     * builder's claim). Defaults to the Postgres invalid-leftover query.
     */
    freshNeedsPhysicalRebuild?: (physicalIndexName: string) => Promise<boolean>;
    /**
     * Allow the physical-rebuild check to trigger even on backends
     * without the claim protocol (SQLite). Sound only when the rebuild is
     * a plain idempotent CREATE (system indexes); relational leftover
     * healing requires the claim and keeps the default `false`.
     */
    rebuildWithoutClaim?: boolean;
  }>,
): Promise<MaterializeIndexesEntry> {
  // Narrowed by callsite — guaranteed defined when this is reached
  // (validated in `materializeIndexes`).
  const recordIndexMaterialization = backend.recordIndexMaterialization!;

  const { statusKey, signature, driftLabel, run, existingByStatusKey } = action;
  const statusOverride =
    statusKey === declaration.name ? undefined : { statusName: statusKey };

  // Pre-claim physical check reads the bulk-preloaded set (one catalog
  // query for all candidates), not one round-trip per index.
  const settled = await settleAgainstExisting(
    existingByStatusKey.get(statusKey),
    declaration,
    backend,
    graphId,
    schemaVersion,
    {
      statusKey,
      signature,
      driftLabel,
      needsPhysicalRebuild: (physicalIndexName) =>
        action.physicalRebuildPreload.has(physicalIndexName),
      ...(action.rebuildWithoutClaim === undefined ?
        {}
      : { rebuildWithoutClaim: action.rebuildWithoutClaim }),
    },
  );
  if (settled !== undefined) return settled;

  // Backends whose concurrent builds can deadlock across callers expose a
  // claim primitive; one caller builds, the rest wait and converge through
  // the already-materialized check on re-claim.
  if (hasIndexBuildClaimProtocol(backend)) {
    return materializeWithClaim(declaration, backend, graphId, schemaVersion, {
      statusKey,
      signature,
      driftLabel,
      run,
      ...(action.freshNeedsPhysicalRebuild === undefined ?
        {}
      : { freshNeedsPhysicalRebuild: action.freshNeedsPhysicalRebuild }),
      ...(action.rebuildWithoutClaim === undefined ?
        {}
      : { rebuildWithoutClaim: action.rebuildWithoutClaim }),
    });
  }

  try {
    await run();
    const attemptedAt = nowIso();
    await recordIndexMaterialization(
      buildAttempt({
        declaration,
        graphId,
        signature,
        schemaVersion,
        materializedAt: attemptedAt,
        error: undefined,
        attemptedAt,
        ...statusOverride,
      }),
    );
    return entry(declaration, "created");
  } catch (error_) {
    const error = error_ instanceof Error ? error_ : new Error(String(error_));
    await recordIndexMaterialization(
      buildAttempt({
        declaration,
        graphId,
        signature,
        schemaVersion,
        materializedAt: undefined,
        error,
        ...statusOverride,
      }),
    );
    return entry(declaration, "failed", error);
  }
}

/**
 * Applies the existing-status decision: `alreadyMaterialized` on a prior
 * success with a matching signature, a recorded `failed` on signature
 * drift, and `undefined` when a build is needed. Shared by the pre-claim
 * check (against the bulk-preloaded rows) and the post-claim re-check
 * (against a fresh read — the preload is stale after waiting on a claim).
 */
async function settleAgainstExisting(
  existing: IndexMaterializationRow | undefined,
  declaration: MaterializableIndexIdentity,
  backend: GraphBackend,
  graphId: string,
  schemaVersion: number,
  action: Readonly<{
    statusKey: string;
    signature: string;
    driftLabel: string;
    /**
     * Whether the physical index behind this name is unusable and must be
     * rebuilt despite the recorded success (INVALID leftover; for system
     * indexes also physically absent). The pre-claim caller reads a
     * bulk-preloaded set (one query for all candidates); the post-claim
     * caller reads fresh (the preload is stale after waiting on another
     * builder's claim).
     */
    needsPhysicalRebuild: (
      physicalIndexName: string,
    ) => boolean | Promise<boolean>;
    /** See `materializeOne`'s action field of the same name. */
    rebuildWithoutClaim?: boolean;
  }>,
): Promise<MaterializeIndexesEntry | undefined> {
  if (existing?.materializedAt === undefined) return undefined;
  const { statusKey, signature, driftLabel, needsPhysicalRebuild } = action;
  if (existing.signature === signature) {
    // A recorded success is only trustworthy while the physical index is
    // usable: a run interrupted after `CREATE ... IF NOT EXISTS` silently
    // kept an invalid leftover (or a pre-claim-protocol run recorded
    // success over one), and a dump/restore or manual drop can leave a
    // success row for an index that no longer exists. Fall through to the
    // build path — under the claim it drops any leftover and rebuilds;
    // `rebuildWithoutClaim` callers re-run their plain idempotent CREATE.
    if (
      declaration.entity !== "vector" &&
      (hasIndexBuildClaimProtocol(backend) ||
        action.rebuildWithoutClaim === true) &&
      (await needsPhysicalRebuild(declaration.name))
    ) {
      return undefined;
    }
    return entry(declaration, "alreadyMaterialized");
  }
  const error = new Error(
    `${driftLabel} "${declaration.name}" already materialized with a different signature (recorded by graph "${existing.graphId}" at version ${existing.schemaVersion}). Drop the index manually and retry, or rename the new declaration.`,
  );
  await backend.recordIndexMaterialization!(
    buildAttempt({
      declaration,
      graphId,
      signature,
      schemaVersion,
      materializedAt: undefined,
      error,
      ...(statusKey === declaration.name ? {} : { statusName: statusKey }),
    }),
  );
  return entry(declaration, "failed", error);
}

/**
 * Builds one index under the cross-caller claim protocol.
 *
 * Claim → re-check → build → record → release. Losers retry the claim on
 * an interval: once the winner records its result and releases, the next
 * claim succeeds and the fresh status re-check settles them as
 * `alreadyMaterialized` (or surfaces the winner's drift failure) without
 * ever issuing a second same-index CONCURRENTLY build — the shape that
 * deadlocks on Postgres (expression-index CIC gets no safe-snapshot
 * exemption). A crashed holder's claim expires after the lease; the
 * takeover drops the invalid leftover its interrupted build left behind
 * (relational indexes — the declaration name IS the physical name) before
 * rebuilding.
 */
async function materializeWithClaim(
  declaration: MaterializableIndexIdentity,
  backend: GraphBackend,
  graphId: string,
  schemaVersion: number,
  action: Readonly<{
    statusKey: string;
    signature: string;
    driftLabel: string;
    run: () => Promise<void>;
    freshNeedsPhysicalRebuild?: (physicalIndexName: string) => Promise<boolean>;
    rebuildWithoutClaim?: boolean;
  }>,
): Promise<MaterializeIndexesEntry> {
  const { statusKey, signature, driftLabel, run } = action;
  const statusOverride =
    statusKey === declaration.name ? undefined : { statusName: statusKey };
  const recordIndexMaterialization = backend.recordIndexMaterialization!;
  const token = `${statusKey}:${nowIso()}:${Math.floor(performance.now() * 1000)}`;
  const deadline = Date.now() + CLAIM_WAIT_TIMEOUT_MS;

  for (;;) {
    const claimed = await backend.claimIndexMaterialization!({
      indexName: statusKey,
      graphId,
      entity: declaration.entity,
      kind: declaration.kind,
      signature,
      schemaVersion,
      token,
      leaseMs: CLAIM_LEASE_MS,
    });

    if (!claimed) {
      if (Date.now() >= deadline) {
        return entry(
          declaration,
          "failed",
          new Error(
            `Timed out waiting for a concurrent materializer's claim on "${statusKey}" (waited ${String(CLAIM_WAIT_TIMEOUT_MS)}ms). If its holder crashed, retry after the lease expires.`,
          ),
        );
      }
      await delay(CLAIM_RETRY_DELAY_MS);
      continue;
    }

    try {
      // Fresh re-check: the bulk preload happened before (possibly) waiting
      // on another caller's build.
      const fresh = await backend.getIndexMaterialization!(statusKey);
      const settled = await settleAgainstExisting(
        fresh,
        declaration,
        backend,
        graphId,
        schemaVersion,
        {
          statusKey,
          signature,
          driftLabel,
          // Post-claim the bulk preload is stale (we may have waited on
          // another builder's claim), so re-check this index fresh.
          needsPhysicalRebuild:
            action.freshNeedsPhysicalRebuild ??
            ((physicalIndexName) =>
              hasInvalidIndexLeftover(backend, physicalIndexName)),
          ...(action.rebuildWithoutClaim === undefined ?
            {}
          : { rebuildWithoutClaim: action.rebuildWithoutClaim }),
        },
      );
      if (settled !== undefined) return settled;

      if (declaration.entity !== "vector") {
        await dropInvalidIndexLeftover(backend, declaration.name);
      }

      try {
        await run();
        const attemptedAt = nowIso();
        await recordIndexMaterialization(
          buildAttempt({
            declaration,
            graphId,
            signature,
            schemaVersion,
            materializedAt: attemptedAt,
            error: undefined,
            attemptedAt,
            ...statusOverride,
          }),
        );
        return entry(declaration, "created");
      } catch (error_) {
        const error =
          error_ instanceof Error ? error_ : new Error(String(error_));
        await recordIndexMaterialization(
          buildAttempt({
            declaration,
            graphId,
            signature,
            schemaVersion,
            materializedAt: undefined,
            error,
            ...statusOverride,
          }),
        );
        return entry(declaration, "failed", error);
      }
    } finally {
      // A claim-release failure must not mask the build's own outcome — a
      // successful build must not surface as a thrown rejection, and one
      // bucket's release error must not abort its siblings. The claim carries
      // a lease (CLAIM_LEASE_MS) and self-expires, so a missed release is
      // reclaimed by the next materializer; warn and move on.
      try {
        await backend.releaseIndexMaterializationClaim!({
          indexName: statusKey,
          token,
        });
      } catch (releaseError) {
        console.warn(
          `typegraph: failed to release the index materialization claim for ` +
            `"${statusKey}"; it will expire on its lease and be reclaimed ` +
            `automatically.`,
          releaseError,
        );
      }
    }
  }
}

/**
 * Whether an index with this name exists but is INVALID (an interrupted
 * CONCURRENTLY build's leftover). False for absent or valid indexes and
 * on non-Postgres dialects.
 */
async function hasInvalidIndexLeftover(
  backend: GraphBackend,
  physicalIndexName: string,
): Promise<boolean> {
  if (backend.dialect !== "postgres") return false;
  // Scoped to the session search_path like preloadPhysicalIndexStates —
  // an unscoped probe could steer the unqualified DROP INDEX heal at
  // another schema's identically-named (valid) index.
  const rows = await backend.execute<{ invalid: boolean }>(
    asCompiledRowsSql(sql`
      SELECT NOT i.indisvalid AS invalid
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = ${physicalIndexName}
        AND pg_catalog.pg_table_is_visible(c.oid)
    `),
  );
  return rows[0]?.invalid === true;
}

/**
 * Bulk variant of `hasInvalidIndexLeftover`: the set of INVALID leftover
 * index names among `physicalIndexNames`, resolved in ONE `pg_index` query.
 * Empty set on non-Postgres dialects or empty input.
 *
 * A warm start (every index already materialized with a matching signature)
 * would otherwise fire `hasInvalidIndexLeftover` once per already-materialized
 * relational index inside `settleAgainstExisting` — N `pg_index` round-trips.
 * Preloading the whole set collapses that to one, mirroring how
 * `preloadMaterializations` batches the status reads it sits beside.
 */
async function preloadInvalidIndexLeftovers(
  backend: GraphBackend,
  physicalIndexNames: readonly string[],
): Promise<ReadonlySet<string>> {
  if (backend.dialect !== "postgres" || physicalIndexNames.length === 0) {
    return new Set();
  }
  const { invalid } = await preloadPhysicalIndexStates(
    backend,
    physicalIndexNames,
  );
  return invalid;
}

type PhysicalIndexStates = Readonly<{
  /** Names that exist as usable indexes in the engine catalog. */
  valid: ReadonlySet<string>;
  /** Postgres INVALID leftovers from interrupted CONCURRENTLY builds. */
  invalid: ReadonlySet<string>;
}>;

/**
 * Partitions `physicalIndexNames` by their catalog state in ONE query:
 * `valid` (usable index exists) and `invalid` (Postgres CONCURRENTLY
 * leftover needing the healing build path). SQLite has no invalid state,
 * so its `invalid` set is always empty. The single query serves both the
 * relational runner's leftover preload and the system runner's
 * name-presence fast path — the two predicates are complementary halves
 * of the same `pg_class ⋈ pg_index` probe.
 */
async function preloadPhysicalIndexStates(
  backend: GraphBackend,
  physicalIndexNames: readonly string[],
): Promise<PhysicalIndexStates> {
  const valid = new Set<string>();
  const invalid = new Set<string>();
  if (physicalIndexNames.length === 0) return { valid, invalid };
  if (backend.dialect === "postgres") {
    // `pg_table_is_visible` scopes the probe to the session search_path —
    // the same resolution the unqualified CREATE/DROP INDEX DDL uses — so
    // a schema-per-tenant database never settles one schema's index based
    // on another schema's identically-named one (matches buildTableExists
    // in backend/drizzle/operations/strategy.ts).
    const rows = await backend.execute<{ name: string; valid: boolean }>(
      asCompiledRowsSql(sql`
        SELECT c.relname AS name, i.indisvalid AS valid
        FROM pg_class c
        JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname IN (${sqlValueList(physicalIndexNames)})
          AND pg_catalog.pg_table_is_visible(c.oid)
      `),
    );
    for (const row of rows) (row.valid ? valid : invalid).add(row.name);
    return { valid, invalid };
  }
  const rows = await backend.execute<{ name: string }>(
    asCompiledRowsSql(sql`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
        AND name IN (${sqlValueList(physicalIndexNames)})
    `),
  );
  for (const row of rows) valid.add(row.name);
  return { valid, invalid };
}

/**
 * Self-heals an interrupted CONCURRENTLY build: a crashed CIC leaves an
 * INVALID index behind, and a later `CREATE INDEX CONCURRENTLY IF NOT
 * EXISTS` would see the name and silently no-op — recording success over an
 * index the planner will never use. Detect via `hasInvalidIndexLeftover` and
 * drop (also CONCURRENTLY — same no-transaction rule). Valid indexes are
 * never touched.
 */
async function dropInvalidIndexLeftover(
  backend: GraphBackend,
  physicalIndexName: string,
): Promise<void> {
  if (backend.executeDdl === undefined) return;
  if (!(await hasInvalidIndexLeftover(backend, physicalIndexName))) return;
  const quoted = `"${physicalIndexName.replaceAll('"', '""')}"`;
  await backend.executeDdl(`DROP INDEX CONCURRENTLY IF EXISTS ${quoted};`);
}

function entry(
  declaration: MaterializableIndexIdentity,
  status: MaterializeIndexesEntry["status"],
  error?: Error,
): MaterializeIndexesEntry {
  return {
    indexName: declaration.name,
    entity: declaration.entity,
    kind: declaration.kind,
    status,
    ...(error === undefined ? {} : { error }),
  };
}

function skippedEntry(
  declaration: VectorIndexDeclaration,
  reason: string,
): MaterializeIndexesEntry {
  return {
    indexName: declaration.name,
    entity: "vector",
    kind: declaration.kind,
    status: "skipped",
    reason,
  };
}

/**
 * Compose the per-deployment status-table key for a vector index.
 * Pgvector physical indexes are partial-by-graph_id (one per graph),
 * so the status table needs graph-scoped identity to disambiguate
 * two graphs reusing the same declaration name. The `::` separator
 * keeps the compound visually unambiguous when inspecting the table.
 */
export function vectorStatusKey(
  graphId: string,
  declarationName: string,
): string {
  return `${graphId}::${declarationName}`;
}

function statusKeyFor(declaration: IndexDeclaration, graphId: string): string {
  return declaration.entity === "vector" ?
      vectorStatusKey(graphId, declaration.name)
    : declaration.name;
}

/**
 * Bulk-load the recorded materialization rows for `statusKeys` into a
 * Map keyed by status key. Backends that implement
 * `getIndexMaterializations` return everything in one round-trip;
 * legacy backends fall back to per-key parallel `getIndexMaterialization`
 * calls. Missing rows are simply absent from the map.
 */
async function preloadMaterializations(
  backend: GraphBackend,
  statusKeys: readonly string[],
): Promise<ReadonlyMap<string, IndexMaterializationRow>> {
  const map = new Map<string, IndexMaterializationRow>();
  if (statusKeys.length === 0) return map;
  if (backend.getIndexMaterializations !== undefined) {
    const rows = await backend.getIndexMaterializations(statusKeys);
    for (const row of rows) map.set(row.indexName, row);
    return map;
  }
  const getOne = backend.getIndexMaterialization!;
  const rows = await Promise.all(statusKeys.map((key) => getOne(key)));
  for (const [index, row] of rows.entries()) {
    if (row !== undefined) map.set(statusKeys[index]!, row);
  }
  return map;
}

function buildAttempt(
  args: Readonly<{
    declaration: MaterializableIndexIdentity;
    graphId: string;
    signature: string;
    schemaVersion: number;
    materializedAt: string | undefined;
    error: Error | undefined;
    attemptedAt?: string;
    /**
     * Override the status-table identity. Used by vector entries to
     * inject the graph-scoped compound key (`vectorStatusKey`).
     * Relational entries default to the declaration name because
     * physical CREATE INDEX names are already database-global.
     */
    statusName?: string;
  }>,
): RecordIndexMaterializationParams {
  return {
    indexName: args.statusName ?? args.declaration.name,
    graphId: args.graphId,
    entity: args.declaration.entity,
    kind: args.declaration.kind,
    signature: args.signature,
    schemaVersion: args.schemaVersion,
    attemptedAt: args.attemptedAt ?? nowIso(),
    materializedAt: args.materializedAt,
    error: args.error?.message,
  };
}

// ============================================================
// System indexes
// ============================================================

export type MaterializeSystemIndexesOptions = Readonly<{
  /** Stop on the first failure. Default: false (best-effort). */
  stopOnError?: boolean;
  /** Refresh planner statistics after a creation. Default: true. */
  refreshStatistics?: boolean;
}>;

type SystemIndexCandidate = Readonly<{
  declaration: SystemIndexDeclaration;
  physicalTable: string;
  name: string;
}>;

/**
 * Materializes TypeGraph's own base-relation indexes
 * (`SYSTEM_INDEX_DECLARATIONS`) against the live database.
 *
 * Bootstrap DDL runs only on first boot, so a system index added in a new
 * library version never reaches an already-initialized database on its
 * own — this runner is the upgrade path. It rides the same per-deployment
 * status table, drift signatures, invalid-leftover healing, and Postgres
 * `CREATE INDEX CONCURRENTLY` cross-caller claim protocol as
 * graph-declared indexes; on a database whose indexes all exist, a warm
 * call costs two concurrent reads (status preload + catalog preload) and runs no
 * DDL after the first recorded success.
 *
 * Graph-independent: the declarations don't depend on `GraphDef`. The
 * `graphId` is recorded on status rows for observability only ("who
 * materialized this"), matching relational rows' semantics.
 *
 * Unlike expression indexes, a system index is fully identified by its
 * physical name, so a candidate that already exists in the engine catalog
 * (valid, with no recorded status row) settles as `alreadyMaterialized`
 * from one bulk catalog read — no claim, no DDL, no status write. Status
 * rows are recorded only for genuine builds and failures, which keeps the
 * common boot (fresh bootstrap or wiped status table) at two concurrent
 * reads. A status row that exists with a mismatching signature still
 * surfaces as drift, exactly like graph-declared indexes.
 */
/**
 * Whether the backend carries every primitive index materialization
 * requires (DDL execution + status reads/writes). The strict runners
 * throw `ConfigurationError` exactly when this is false; the boot path
 * (`createStoreWithSchema`) consults the same predicate to skip instead
 * — one definition so the two contracts cannot drift apart.
 */
export function backendSupportsIndexMaterialization(
  backend: GraphBackend,
): boolean {
  return (
    backend.executeDdl !== undefined &&
    backend.getIndexMaterialization !== undefined &&
    backend.recordIndexMaterialization !== undefined
  );
}

/**
 * Strict-side counterpart of {@link backendSupportsIndexMaterialization}:
 * the runners' throw-guard, derived from the same predicate the boot
 * path's skip-guard consults.
 */
function assertBackendSupportsIndexMaterialization(
  backend: GraphBackend,
  surface: string,
): void {
  if (backendSupportsIndexMaterialization(backend)) return;
  throw new ConfigurationError(
    `${surface} requires a backend with \`executeDdl\` and the index ` +
      "materialization status primitives (`getIndexMaterialization`, " +
      "`recordIndexMaterialization`). The bundled SQLite and Postgres " +
      "backends provide them; a custom backend must implement all three.",
    { code: "MATERIALIZE_BACKEND_UNSUPPORTED" },
  );
}

export async function materializeSystemIndexes(
  context: Readonly<{
    backend: RawBackend;
    graphId: string;
    schemaVersion: number;
  }>,
  options: MaterializeSystemIndexesOptions = {},
): Promise<MaterializeIndexesResult> {
  const { backend, graphId, schemaVersion } = context;

  assertBackendSupportsIndexMaterialization(
    backend,
    "store.materializeSystemIndexes()",
  );

  await ensureFocusedStatusTable(
    backend,
    backend.ensureIndexMaterializationsTable,
  );

  const concurrent = backend.dialect === "postgres";
  const candidates: readonly SystemIndexCandidate[] =
    SYSTEM_INDEX_DECLARATIONS.map((declaration) => {
      const physicalTable = resolveSystemIndexTableName(
        declaration.table,
        backend.tableNames,
      );
      return {
        declaration,
        physicalTable,
        name: systemIndexName(physicalTable, declaration.suffix),
      };
    });

  // The two preloads are mutually independent reads (status table +
  // catalog); running them concurrently keeps the warm boot at one
  // round-trip latency after the ensure step.
  const statusKeys = candidates.map((candidate) => candidate.name);
  const [existingByStatusKey, physicalStates] = await Promise.all([
    preloadMaterializations(backend, statusKeys),
    preloadPhysicalIndexStates(backend, statusKeys),
  ]);
  const { valid: physicallyPresent } = physicalStates;
  // Physical state is authoritative for system indexes: absent or INVALID
  // must rebuild even under a matching success row (dump/restore, manual
  // drop). One set serves every candidate's pre-claim check.
  const physicalRebuildPreload: ReadonlySet<string> = new Set(
    statusKeys.filter((name) => !physicallyPresent.has(name)),
  );

  const materializeEntry = async (
    candidate: SystemIndexCandidate,
  ): Promise<MaterializeIndexesEntry> => {
    const identity: MaterializableIndexIdentity = {
      name: candidate.name,
      entity: "system",
      kind: candidate.declaration.table,
    };
    const existing = existingByStatusKey.get(candidate.name);

    // A status row owned by another entity means a graph-declared index
    // was materialized under this name. Refuse WITHOUT writing: driving
    // this through the drift path would record a system-signature failure
    // over the graph-declared index's row and permanently brick it.
    if (existing !== undefined && existing.entity !== "system") {
      return entry(
        identity,
        "failed",
        new Error(
          `System index name "${candidate.name}" is already recorded by a ` +
            `${existing.entity} index declaration (graph "${existing.graphId}"). ` +
            `Rename the graph-declared index — "typegraph_"-prefixed names ` +
            `belong to TypeGraph's system indexes.`,
        ),
      );
    }

    // Name-presence fast path: valid physical index, no status row — the
    // normal steady state, since bootstrap DDL creates system indexes
    // without recording status rows. Trusting name-presence is sound
    // ONLY here: system index names are library-owned with a stable
    // name→shape contract (reshaping requires a rename), whereas a
    // graph-declared index name could collide with a foreign index whose
    // shape only the recorded signature can vouch for. Known limitation
    // of that contract: a declaration reshaped in place (violating the
    // rename rule) is NOT detected on bootstrap-created databases, since
    // there is no recorded signature to drift against — the rename rule
    // is enforced by review and the parity tests, not at runtime. A row
    // with a mismatching signature must NOT take the fast path — that is
    // drift, and the frame below records it as a failure.
    if (existing === undefined && physicallyPresent.has(candidate.name)) {
      return entry(identity, "alreadyMaterialized");
    }
    const signature = await computeSystemIndexSignature(
      backend.dialect,
      candidate.physicalTable,
      candidate.declaration,
    );
    const ddl = generateSystemIndexDDL(
      candidate.declaration,
      candidate.physicalTable,
      { concurrent },
    );
    return materializeOne(identity, backend, graphId, schemaVersion, {
      statusKey: candidate.name,
      signature,
      driftLabel: "System index",
      run: () => backend.executeDdl!(ddl),
      existingByStatusKey,
      physicalRebuildPreload,
      freshNeedsPhysicalRebuild: async (physicalIndexName) => {
        const fresh = await preloadPhysicalIndexStates(backend, [
          physicalIndexName,
        ]);
        return !fresh.valid.has(physicalIndexName);
      },
      rebuildWithoutClaim: true,
    });
  };

  // Same shape as the relational runner: one CONCURRENTLY build per
  // relation, so buckets key on the physical table.
  const results = await runBucketedMaterialization(
    candidates,
    options,
    (candidate) => candidate.physicalTable,
    (candidate) => materializeEntry(candidate),
  );
  await refreshStatisticsAfterCreation(backend, results, options, concurrent);
  return { results };
}

/**
 * Canonical hash of `{ dialect, targetTableName, declaration }` for a
 * system-index declaration — same drift contract as
 * `computeIndexSignature`: changing a declaration's shape under the same
 * suffix mismatches the recorded signature and surfaces as a `failed`
 * entry until the operator drops the old physical index (rename instead).
 */
async function computeSystemIndexSignature(
  dialect: SqlDialect,
  targetTableName: string,
  declaration: SystemIndexDeclaration,
): Promise<string> {
  const json = JSON.stringify(
    { dialect, targetTableName, declaration },
    sortedReplacer,
  );
  return sha256Hex(json, 16);
}

/**
 * Canonical hash of `{ dialect, targetTableName, declaration }`.
 *
 * Includes the physical target table name because custom backends can
 * remap `typegraph_nodes` / `typegraph_edges` — a declaration-only
 * signature would falsely report "already materialized" after a table
 * rename. Excludes execution flags (`CONCURRENTLY`, `IF NOT EXISTS`)
 * because those are runtime modifiers, not shape.
 *
 * `declaration` is canonicalized via `serializeIndexDeclaration` before
 * hashing — `defineGraph` accepts pre-built `IndexDeclaration`s directly
 * (bypassing `defineNodeIndex`'s own canonicalization), so a raw
 * declaration with e.g. a present-but-empty `keySystemColumns: []` would
 * otherwise hash differently from the same declaration with the field
 * omitted, spuriously forcing re-materialization for no real shape change.
 */
export async function computeIndexSignature(
  dialect: SqlDialect,
  targetTableName: string,
  declaration: IndexDeclaration,
): Promise<string> {
  const hashable = {
    dialect,
    targetTableName,
    declaration: serializeIndexDeclaration(declaration),
  };
  const json = JSON.stringify(hashable, sortedReplacer);
  return sha256Hex(json, 16);
}
