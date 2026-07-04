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
  type IndexDeclaration,
  type RelationalIndexDeclaration,
  type VectorIndexDeclaration,
} from "../indexes/types";
import { type SqlDialect } from "../query/dialect/types";
import { asCompiledRowsSql } from "../query/sql-intent";
import { sortedReplacer } from "../schema/canonical";
import { nowIso } from "../utils/date";
import { sha256Hex } from "../utils/hash";
import { ensureFocusedStatusTable } from "./materialize-shared";

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

  if (backend.executeDdl === undefined) {
    throw new ConfigurationError(
      "store.materializeIndexes() requires a backend with `executeDdl` " +
        "support. The bundled SQLite and Postgres backends provide it; " +
        "a custom backend without `executeDdl` cannot run index DDL.",
      { code: "MATERIALIZE_BACKEND_UNSUPPORTED" },
    );
  }
  if (
    backend.getIndexMaterialization === undefined ||
    backend.recordIndexMaterialization === undefined
  ) {
    throw new ConfigurationError(
      "store.materializeIndexes() requires a backend with index " +
        "materialization status primitives. The bundled SQLite and " +
        "Postgres backends provide them; a custom backend must implement " +
        "`getIndexMaterialization` and `recordIndexMaterialization`.",
      { code: "MATERIALIZE_BACKEND_UNSUPPORTED" },
    );
  }

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
      )
    : materializeRelationalIndex(
        declaration,
        backend,
        dialect,
        ddlOptions,
        graphId,
        schemaVersion,
        existingByStatusKey,
      );

  if (options.stopOnError === true) {
    const results: MaterializeIndexesEntry[] = [];
    for (const declaration of candidates) {
      const entry = await materializeEntry(declaration);
      results.push(entry);
      if (entry.status === "failed") break;
    }
    await refreshStatisticsAfterCreation(
      backend,
      results,
      options,
      ddlOptions.concurrent,
    );
    return { results };
  }

  // Postgres restricts `CREATE INDEX CONCURRENTLY` to one in-flight
  // build per relation, so we group declarations by target table and
  // run each group sequentially while running the groups in parallel.
  // Typical schemas land in three buckets (nodes, edges, vector
  // embeddings), giving a ~3× round-trip win over fully sequential
  // without ever issuing two CONCURRENTLY builds against the same
  // relation. SQLite ignores the grouping (writes serialize at the
  // engine level either way).
  const buckets = new Map<IndexEntity, IndexDeclaration[]>();
  for (const declaration of candidates) {
    const key = parallelBucketKey(declaration);
    const list = buckets.get(key);
    if (list === undefined) buckets.set(key, [declaration]);
    else list.push(declaration);
  }

  const bucketResults = await Promise.all(
    [...buckets.values()].map(async (group) => {
      const out: MaterializeIndexesEntry[] = [];
      for (const declaration of group) {
        out.push(await materializeEntry(declaration));
      }
      return out;
    }),
  );

  // Flatten in declaration order so callers see a stable result shape
  // regardless of how the buckets resolved.
  const byDeclaration = new Map<IndexDeclaration, MaterializeIndexesEntry>();
  let bucketIndex = 0;
  for (const group of buckets.values()) {
    const entries = bucketResults[bucketIndex]!;
    for (const [declarationIndex, declaration] of group.entries()) {
      byDeclaration.set(declaration, entries[declarationIndex]!);
    }
    bucketIndex += 1;
  }
  const results = candidates.map((declaration) =>
    byDeclaration.get(declaration)!,
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
  if (usesConcurrentBuilds && backend.claimIndexMaterialization === undefined)
    return;
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
  });
}

async function materializeVectorIndex(
  declaration: VectorIndexDeclaration,
  backend: GraphBackend,
  graphId: string,
  schemaVersion: number,
  existingByStatusKey: ReadonlyMap<string, IndexMaterializationRow>,
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
  });
}

/**
 * Shared "check existing → run → record" frame for both relational and
 * vector materialization. Both paths track a per-deployment status row
 * keyed by `statusKey`, short-circuit on a matching signature, surface
 * signature drift as a recorded failure, and execute `run()` on first
 * materialization. Differences live entirely in the `MaterializeAction`
 * the caller passes.
 */
async function materializeOne(
  declaration: IndexDeclaration,
  backend: GraphBackend,
  graphId: string,
  schemaVersion: number,
  action: Readonly<{
    statusKey: string;
    signature: string;
    driftLabel: string;
    run: () => Promise<void>;
    existingByStatusKey: ReadonlyMap<string, IndexMaterializationRow>;
  }>,
): Promise<MaterializeIndexesEntry> {
  // Narrowed by callsite — guaranteed defined when this is reached
  // (validated in `materializeIndexes`).
  const recordIndexMaterialization = backend.recordIndexMaterialization!;

  const { statusKey, signature, driftLabel, run, existingByStatusKey } = action;
  const statusOverride =
    statusKey === declaration.name ? undefined : { statusName: statusKey };

  const settled = await settleAgainstExisting(
    existingByStatusKey.get(statusKey),
    declaration,
    backend,
    graphId,
    schemaVersion,
    { statusKey, signature, driftLabel },
  );
  if (settled !== undefined) return settled;

  // Backends whose concurrent builds can deadlock across callers expose a
  // claim primitive; one caller builds, the rest wait and converge through
  // the already-materialized check on re-claim.
  if (
    backend.claimIndexMaterialization !== undefined &&
    backend.releaseIndexMaterializationClaim !== undefined
  ) {
    return materializeWithClaim(declaration, backend, graphId, schemaVersion, {
      statusKey,
      signature,
      driftLabel,
      run,
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
  declaration: IndexDeclaration,
  backend: GraphBackend,
  graphId: string,
  schemaVersion: number,
  action: Readonly<{
    statusKey: string;
    signature: string;
    driftLabel: string;
  }>,
): Promise<MaterializeIndexesEntry | undefined> {
  if (existing?.materializedAt === undefined) return undefined;
  const { statusKey, signature, driftLabel } = action;
  if (existing.signature === signature) {
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
  declaration: IndexDeclaration,
  backend: GraphBackend,
  graphId: string,
  schemaVersion: number,
  action: Readonly<{
    statusKey: string;
    signature: string;
    driftLabel: string;
    run: () => Promise<void>;
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
        { statusKey, signature, driftLabel },
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
      await backend.releaseIndexMaterializationClaim!({
        indexName: statusKey,
        token,
      });
    }
  }
}

/**
 * Self-heals an interrupted CONCURRENTLY build: a crashed CIC leaves an
 * INVALID index behind, and a later `CREATE INDEX CONCURRENTLY IF NOT
 * EXISTS` would see the name and silently no-op — recording success over
 * an index the planner will never use. Detect via pg_index and drop
 * (also CONCURRENTLY — same no-transaction rule). Valid indexes are never
 * touched.
 */
async function dropInvalidIndexLeftover(
  backend: GraphBackend,
  physicalIndexName: string,
): Promise<void> {
  if (backend.dialect !== "postgres") return;
  if (backend.executeDdl === undefined) return;
  const rows = await backend.execute<{ invalid: boolean }>(
    asCompiledRowsSql(sql`
      SELECT NOT i.indisvalid AS invalid
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = ${physicalIndexName}
    `),
  );
  const row = rows[0];
  if (!row?.invalid) return;
  const quoted = `"${physicalIndexName.replaceAll('"', '""')}"`;
  await backend.executeDdl(`DROP INDEX CONCURRENTLY IF EXISTS ${quoted};`);
}

function entry(
  declaration: IndexDeclaration,
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
    declaration: IndexDeclaration;
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

/**
 * Canonical hash of `{ dialect, targetTableName, declaration }`.
 *
 * Includes the physical target table name because custom backends can
 * remap `typegraph_nodes` / `typegraph_edges` — a declaration-only
 * signature would falsely report "already materialized" after a table
 * rename. Excludes execution flags (`CONCURRENTLY`, `IF NOT EXISTS`)
 * because those are runtime modifiers, not shape.
 */
export async function computeIndexSignature(
  dialect: SqlDialect,
  targetTableName: string,
  declaration: IndexDeclaration,
): Promise<string> {
  const hashable = { dialect, targetTableName, declaration };
  const json = JSON.stringify(hashable, sortedReplacer);
  return sha256Hex(json, 16);
}
