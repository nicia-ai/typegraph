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
  type RecordIndexMaterializationParams,
} from "../backend/types";
import { type GraphDef } from "../core/define-graph";
import { ConfigurationError } from "../errors";
import {
  generateIndexDDL,
  type IndexDeclaration,
  type RelationalIndexDeclaration,
  type VectorIndexDeclaration,
} from "../indexes";
import { sortedReplacer } from "../schema/canonical";
import { nowIso } from "../utils/date";

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
  entity: "node" | "edge" | "vector";
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
        throw new ConfigurationError(
          `Cannot materialize indexes for unknown kind "${name}" on graph "${graphId}". Only kinds declared on the graph (compile-time or runtime) can be passed to materializeIndexes.`,
          { code: "MATERIALIZE_UNKNOWN_KIND" },
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
  // the agent-loop pattern where `evolve(sameExt, { eager: true })`
  // is repeated.
  if (candidates.length === 0) {
    return { results: [] };
  }

  // Ensure ONLY the materializations status table exists for legacy
  // DBs whose base tables predate this slot. Deliberately scoped to
  // one table — `bootstrapTables` issues 20+ CREATE TABLE / CREATE
  // INDEX statements covering every base table, and two concurrent
  // calls (e.g. two replicas starting up and calling
  // `materializeIndexes`) deadlock on Postgres SHARE locks.
  // `ensureIndexMaterializationsTable` is the focused alternative
  // that the bundled backends provide; legacy custom backends without
  // it fall back to `bootstrapTables` (retains the deadlock risk under
  // concurrent callers but preserves backward compatibility).
  await (backend.ensureIndexMaterializationsTable === undefined ?
    backend.bootstrapTables?.()
  : backend.ensureIndexMaterializationsTable());

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

  const results: MaterializeIndexesEntry[] = [];
  for (const declaration of candidates) {
    const entry =
      declaration.entity === "vector" ?
        await materializeVectorIndex(
          declaration,
          backend,
          graphId,
          schemaVersion,
        )
      : await materializeRelationalIndex(
          declaration,
          backend,
          dialect,
          ddlOptions,
          graphId,
          schemaVersion,
        );
    results.push(entry);
    if (entry.status === "failed" && options.stopOnError === true) break;
  }

  return { results };
}

async function materializeRelationalIndex(
  declaration: RelationalIndexDeclaration,
  backend: GraphBackend,
  dialect: "sqlite" | "postgres",
  ddlOptions: Readonly<{
    ifNotExists: boolean;
    concurrent: boolean;
    nodesTableName?: string;
    edgesTableName?: string;
  }>,
  graphId: string,
  schemaVersion: number,
): Promise<MaterializeIndexesEntry> {
  // Narrowed by callsite — these are guaranteed defined when this is
  // reached (validated above).
  const executeDdl = backend.executeDdl!;
  const recordIndexMaterialization = backend.recordIndexMaterialization!;
  const getIndexMaterialization = backend.getIndexMaterialization!;

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

  const existing = await getIndexMaterialization(declaration.name);
  if (existing?.materializedAt !== undefined) {
    if (existing.signature === signature) {
      return {
        indexName: declaration.name,
        entity: declaration.entity,
        kind: declaration.kind,
        status: "alreadyMaterialized",
      };
    }
    const error = new Error(
      `Index "${declaration.name}" already materialized with a different signature (recorded by graph "${existing.graphId}" at version ${existing.schemaVersion}). Drop the index manually and retry, or rename the new declaration.`,
    );
    await recordIndexMaterialization(
      buildAttempt({
        declaration,
        graphId,
        signature,
        schemaVersion,
        materializedAt: undefined,
        error,
      }),
    );
    return {
      indexName: declaration.name,
      entity: declaration.entity,
      kind: declaration.kind,
      status: "failed",
      error,
    };
  }

  try {
    await executeDdl(ddl);
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
      }),
    );
    return {
      indexName: declaration.name,
      entity: declaration.entity,
      kind: declaration.kind,
      status: "created",
    };
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
      }),
    );
    return {
      indexName: declaration.name,
      entity: declaration.entity,
      kind: declaration.kind,
      status: "failed",
      error,
    };
  }
}

async function materializeVectorIndex(
  declaration: VectorIndexDeclaration,
  backend: GraphBackend,
  graphId: string,
  schemaVersion: number,
): Promise<MaterializeIndexesEntry> {
  // `indexType: "none"` is a declarative opt-out — the declaration
  // carries shape metadata (dimensions, metric) for tooling but the
  // operator has signaled "no automatic index". Surface as `skipped`.
  if (declaration.indexType === "none") {
    return {
      indexName: declaration.name,
      entity: "vector",
      kind: declaration.kind,
      status: "skipped",
      reason: "indexType: 'none' opts out of automatic materialization",
    };
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
    return {
      indexName: declaration.name,
      entity: "vector",
      kind: declaration.kind,
      status: "skipped",
      reason: `Backend (${backend.dialect}) does not support vector indexes in its current configuration`,
    };
  }
  // Capability check (per index type): backends advertise the specific
  // index implementations they support (e.g. SQLite + sqlite-vec
  // accepts vectors but no HNSW/IVFFlat — the brute-force scan IS the
  // "index"). Surface unsupported types as skipped so consumers see a
  // clear "this backend can't materialize this declaration" signal
  // instead of a silent no-op masquerading as `created`.
  if (!vectorCapability.indexTypes.includes(declaration.indexType)) {
    return {
      indexName: declaration.name,
      entity: "vector",
      kind: declaration.kind,
      status: "skipped",
      reason: `Backend (${backend.dialect}) does not support index type "${declaration.indexType}" for vector indexes; supported: ${vectorCapability.indexTypes.join(", ") || "(none)"}`,
    };
  }

  const recordIndexMaterialization = backend.recordIndexMaterialization!;
  const getIndexMaterialization = backend.getIndexMaterialization!;

  const signature = await computeIndexSignature(
    backend.dialect,
    "typegraph_node_embeddings",
    declaration,
  );

  // Compound status-table key for vector entries. Pgvector creates
  // one physical index per (graphId, kind, field) — so the
  // per-deployment status table needs to disambiguate entries that
  // SHARE a declaration name but belong to different graphs.
  // Applied uniformly to auto-derived AND explicit declarations: the
  // declaration name stays clean for inspection, the status key gets
  // the graph scope. Without this, two graphs reusing the same
  // explicit declaration name would collide — the second would
  // falsely report `alreadyMaterialized` from the first's row.
  const statusKey = vectorStatusKey(graphId, declaration.name);

  const existing = await getIndexMaterialization(statusKey);
  if (existing?.materializedAt !== undefined) {
    if (existing.signature === signature) {
      return {
        indexName: declaration.name,
        entity: "vector",
        kind: declaration.kind,
        status: "alreadyMaterialized",
      };
    }
    const error = new Error(
      `Vector index "${declaration.name}" already materialized with a different signature (recorded by graph "${existing.graphId}" at version ${existing.schemaVersion}). Drop the index manually and retry, or rename the new declaration.`,
    );
    await recordIndexMaterialization(
      buildAttempt({
        declaration,
        graphId,
        signature,
        schemaVersion,
        materializedAt: undefined,
        error,
        statusName: statusKey,
      }),
    );
    return {
      indexName: declaration.name,
      entity: "vector",
      kind: declaration.kind,
      status: "failed",
      error,
    };
  }

  try {
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
    };
    await backend.createVectorIndex(params);
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
        statusName: statusKey,
      }),
    );
    return {
      indexName: declaration.name,
      entity: "vector",
      kind: declaration.kind,
      status: "created",
    };
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
        statusName: statusKey,
      }),
    );
    return {
      indexName: declaration.name,
      entity: "vector",
      kind: declaration.kind,
      status: "failed",
      error,
    };
  }
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
  dialect: string,
  targetTableName: string,
  declaration: IndexDeclaration,
): Promise<string> {
  const hashable = { dialect, targetTableName, declaration };
  const json = JSON.stringify(hashable, sortedReplacer);
  const encoded = new TextEncoder().encode(json);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let index = 0; index < 16; index++) {
    const byte = bytes[index];
    if (byte === undefined) break;
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function isKnownKind(graph: GraphDef, name: string): boolean {
  return Object.hasOwn(graph.nodes, name) || Object.hasOwn(graph.edges, name);
}
