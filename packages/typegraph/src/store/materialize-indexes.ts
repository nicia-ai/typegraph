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
 *   (`pg_index.indisvalid = false`). v1 surfaces this as a `failed`
 *   result; the operator must drop the invalid index manually before
 *   retry.
 */

import {
  type CreateVectorIndexParams,
  type GraphBackend,
  type IndexMaterializationRow,
  type RecordIndexMaterializationParams,
} from "../backend/types";
import { type GraphDef, isKnownKind } from "../core/define-graph";
import type { IndexEntity } from "../core/types";
import { ConfigurationError, KindNotFoundError } from "../errors";
import {
  generateIndexDDL,
  type IndexDeclaration,
  type RelationalIndexDeclaration,
  type VectorIndexDeclaration,
} from "../indexes";
import { type SqlDialect } from "../query/dialect";
import { sortedReplacer } from "../schema/canonical";
import { nowIso } from "../utils/date";
import { sha256Hex } from "../utils/hash";
import { ensureFocusedStatusTable } from "./materialize-shared";

export type MaterializeIndexesOptions = Readonly<{
  /** Restrict to indexes whose `kind` is in this set. */
  kinds?: readonly string[];
  /** Stop on the first failure. Default: false (best-effort). */
  stopOnError?: boolean;
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
  backend: GraphBackend;
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
  return {
    results: candidates.map((declaration) => byDeclaration.get(declaration)!),
  };
}

function parallelBucketKey(declaration: IndexDeclaration): IndexEntity {
  // Vector indexes all target the same physical embeddings table, so
  // they share one bucket. Relational node and edge indexes split into
  // two buckets keyed by entity (graphs override their physical table
  // names but every declaration with the same entity still lands on
  // the same physical table within a given graph). Postgres CIC's
  // "one in-flight build per relation" rule maps to this bucketing.
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
    run: () => backend.executeDdl!(ddl),
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
  // `capabilities.vector` (e.g. SQLite needs sqlite-vec opt-in via
  // `hasVectorEmbeddings: true` at backend creation; Postgres needs
  // pgvector). When unsupported, surface as skipped — the declaration
  // is recognized but the backend can't act on it.
  const vectorCapability = backend.capabilities.vector;
  if (
    vectorCapability?.supported !== true ||
    backend.createVectorIndex === undefined
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

  // Hash against the actual physical embeddings table the backend
  // targets — custom `tableNames.embeddings` would otherwise produce
  // false drift detection (the recorded signature would mismatch the
  // signature computed against the renamed table on every call).
  const embeddingsTable =
    backend.tableNames?.embeddings ?? "typegraph_node_embeddings";
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

  const existing = existingByStatusKey.get(statusKey);
  if (existing?.materializedAt !== undefined) {
    if (existing.signature === signature) {
      return entry(declaration, "alreadyMaterialized");
    }
    const error = new Error(
      `${driftLabel} "${declaration.name}" already materialized with a different signature (recorded by graph "${existing.graphId}" at version ${existing.schemaVersion}). Drop the index manually and retry, or rename the new declaration.`,
    );
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
function vectorStatusKey(graphId: string, declarationName: string): string {
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
async function computeIndexSignature(
  dialect: SqlDialect,
  targetTableName: string,
  declaration: IndexDeclaration,
): Promise<string> {
  const hashable = { dialect, targetTableName, declaration };
  const json = JSON.stringify(hashable, sortedReplacer);
  return sha256Hex(json, 16);
}
