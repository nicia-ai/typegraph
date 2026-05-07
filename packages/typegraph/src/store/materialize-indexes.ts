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
  type GraphBackend,
  type RecordIndexMaterializationParams,
} from "../backend/types";
import { type GraphDef } from "../core/define-graph";
import { ConfigurationError } from "../errors";
import { generateIndexDDL, type IndexDeclaration } from "../indexes";
import { sortedReplacer } from "../schema/canonical";
import { nowIso } from "../utils/date";

export type MaterializeIndexesOptions = Readonly<{
  /** Restrict to indexes whose `kind` is in this set. */
  kinds?: readonly string[];
  /** Stop on the first failure. Default: false (best-effort). */
  stopOnError?: boolean;
}>;

export type MaterializeIndexesEntry = Readonly<{
  indexName: string;
  entity: "node" | "edge";
  kind: string;
  status: "created" | "alreadyMaterialized" | "failed";
  error?: Error;
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

    const existing = await backend.getIndexMaterialization(declaration.name);
    if (existing?.materializedAt !== undefined) {
      if (existing.signature === signature) {
        results.push({
          indexName: declaration.name,
          entity: declaration.entity,
          kind: declaration.kind,
          status: "alreadyMaterialized",
        });
        continue;
      }
      // Signature drift — recorded shape does not match the current
      // declaration. Refuse to silently drop+recreate.
      const error = new Error(
        `Index "${declaration.name}" already materialized with a different signature (recorded by graph "${existing.graphId}" at version ${existing.schemaVersion}). Drop the index manually and retry, or rename the new declaration.`,
      );
      await backend.recordIndexMaterialization(
        buildAttempt({
          declaration,
          graphId,
          signature,
          schemaVersion,
          materializedAt: undefined,
          error,
        }),
      );
      results.push({
        indexName: declaration.name,
        entity: declaration.entity,
        kind: declaration.kind,
        status: "failed",
        error,
      });
      if (options.stopOnError === true) break;
      continue;
    }

    try {
      await backend.executeDdl(ddl);
      const attemptedAt = nowIso();
      await backend.recordIndexMaterialization(
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
      results.push({
        indexName: declaration.name,
        entity: declaration.entity,
        kind: declaration.kind,
        status: "created",
      });
    } catch (error_) {
      const error =
        error_ instanceof Error ? error_ : new Error(String(error_));
      await backend.recordIndexMaterialization(
        buildAttempt({
          declaration,
          graphId,
          signature,
          schemaVersion,
          materializedAt: undefined,
          error,
        }),
      );
      results.push({
        indexName: declaration.name,
        entity: declaration.entity,
        kind: declaration.kind,
        status: "failed",
        error,
      });
      if (options.stopOnError === true) break;
    }
  }

  return { results };
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
  }>,
): RecordIndexMaterializationParams {
  return {
    indexName: args.declaration.name,
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
