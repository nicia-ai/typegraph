/**
 * Data-cleanup phase for `store.removeKinds()`.
 *
 * The removeKinds verb commits the new schema atomically (millisecond
 * budget); the data deletion happens here, scoped per-deployment via
 * the `typegraph_kind_removals` status table. Splitting the verbs
 * mirrors how `materializeIndexes` complements `evolve`: schema
 * commits are atomic and fast, data work is bounded by row count and
 * deferrable / parallelizable.
 */
import { type GraphBackend, type KindRemovalRow } from "../backend/types";
import { ConfigurationError } from "../errors";
import { parseSerializedSchema } from "../schema/manager";
import { nowIso } from "../utils/date";

export type MaterializeRemovalsOptions = Readonly<{
  /** Restrict to specific kind names. */
  kinds?: readonly string[];
  /** Halt on first failure. Default: false (best-effort). */
  stopOnError?: boolean;
}>;

export type MaterializeRemovalsEntry = Readonly<{
  kind: string;
  entity: "node" | "edge";
  status: "removed" | "failed";
  error?: Error;
}>;

export type MaterializeRemovalsResult = Readonly<{
  results: readonly MaterializeRemovalsEntry[];
}>;

type MaterializeRemovalsContext = Readonly<{
  graphId: string;
  backend: GraphBackend;
}>;

export async function materializeRemovals(
  context: MaterializeRemovalsContext,
  options: MaterializeRemovalsOptions = {},
): Promise<MaterializeRemovalsResult> {
  const { backend, graphId } = context;

  if (
    backend.executeDdl === undefined ||
    backend.recordKindRemoval === undefined ||
    backend.getPendingKindRemovals === undefined
  ) {
    throw new ConfigurationError(
      "store.materializeRemovals() requires a backend with kind-removal " +
        "primitives (executeDdl, recordKindRemoval, getPendingKindRemovals). " +
        "The bundled SQLite and Postgres backends provide them.",
      { code: "MATERIALIZE_REMOVALS_BACKEND_UNSUPPORTED" },
    );
  }

  // Ensure the status table exists for legacy DBs whose base tables
  // predate this slot. Same focused-bootstrap rationale as the
  // materializations table — full bootstrapTables can deadlock on
  // Postgres SHARE locks under concurrent replica startup.
  await (backend.ensureKindRemovalsTable === undefined ?
    backend.bootstrapTables?.()
  : backend.ensureKindRemovalsTable());

  // Recovery path: `removeKinds()` commits the schema-version diff
  // (kind dropped from `nodes`/`edges`) BEFORE recording the cleanup
  // queue rows. If the queue write fails between those two steps the
  // schema is durable but the queue is missing rows — and a retry of
  // `removeKinds()` short-circuits on the no-op path because the kind
  // is already absent. Atomicity isn't an option (the schema-commit
  // path takes dialect-specific advisory locks that can't be extended
  // across the status-table write), so reconcile here against schema
  // history: walk every transition, find kinds whose removal isn't
  // reflected in the queue, and re-record them.
  await reconcilePendingRemovals(context);
  const pending = await backend.getPendingKindRemovals(graphId);

  const kindFilter =
    options.kinds === undefined ? undefined : new Set(options.kinds);
  const candidates = pending.filter((row) =>
    kindFilter === undefined ? true : kindFilter.has(row.kindName),
  );

  if (candidates.length === 0) return { results: [] };

  const tableNames = backend.tableNames;
  const nodesTable = tableNames?.nodes ?? "typegraph_nodes";
  const edgesTable = tableNames?.edges ?? "typegraph_edges";

  const ctx = { backend, graphId, nodesTable, edgesTable } as const;

  // When `stopOnError` is set we honor strict sequential semantics; one
  // failure short-circuits the rest. Otherwise each kind targets a
  // disjoint row set (DELETEs filtered by kindName) so we can issue all
  // cleanups concurrently — Postgres parallelizes the DELETE round-trips
  // across pool connections; SQLite serializes writes at the engine
  // level either way.
  if (options.stopOnError === true) {
    const results: MaterializeRemovalsEntry[] = [];
    for (const removal of candidates) {
      const entry = await materializeOne(removal, ctx);
      results.push(entry);
      if (entry.status === "failed") break;
    }
    return { results };
  }

  return {
    results: await Promise.all(
      candidates.map((removal) => materializeOne(removal, ctx)),
    ),
  };
}

/**
 * Walks the schema-version history backward from the active version
 * and re-records any kind-removal whose queue row is missing entirely.
 *
 * Handles the full crash-window recovery: a `removeKinds()` call that
 * commits the schema diff but fails before recording the queue row
 * can be followed by any number of additional schema transitions
 * (evolve, deprecate, further removes) — the lost queue row is still
 * recoverable from schema history because the kind diff at that
 * specific transition is permanent metadata.
 *
 * Uses `getAllKindRemovals` to distinguish "row missing entirely" (the
 * crash window — needs recovery) from "row already completed" (a
 * successful prior cleanup — re-recording would churn
 * `last_attempted_at` even though COALESCE preserves the success).
 * Backends without that primitive fall back to the pending-only set,
 * which keeps reconciliation correct (the COALESCE rule preserves the
 * completed state) but does churn `last_attempted_at` on already-
 * completed rows. The bundled SQLite and Postgres backends implement
 * `getAllKindRemovals`.
 */
async function reconcilePendingRemovals(
  context: MaterializeRemovalsContext,
): Promise<void> {
  const { backend, graphId } = context;
  const recordKindRemoval = backend.recordKindRemoval;
  if (recordKindRemoval === undefined) return;

  const activeRow = await backend.getActiveSchema(graphId);
  if (activeRow === undefined || activeRow.version <= 1) return;

  // Existence map: a (entity, kindName, schemaVersion) is recorded if
  // a row exists in any state (pending or completed). The rows we want
  // to reconcile are the ones missing from this set entirely.
  const allRemovals = await (backend.getAllKindRemovals === undefined ?
    backend.getPendingKindRemovals!(graphId)
  : backend.getAllKindRemovals(graphId));
  const recorded = new Set(
    allRemovals.map((row) =>
      kindRemovalKey(row.entity, row.kindName, row.schemaVersion),
    ),
  );

  const reconciliations: {
    kindName: string;
    entity: "node" | "edge";
    schemaVersion: number;
  }[] = [];

  // Walk backward through transitions. At each pair (priorRow, currentRow)
  // we compute "kinds removed at currentRow.version" and check the
  // existence map — any missing entry needs an idempotent upsert.
  // Walking all the way back is necessary: a crash window at version V
  // may have been followed by additional schema commits, so the active
  // version's predecessor is no longer V. The cost is bounded by the
  // total number of schema versions, which is small for typical
  // schemas; the existence check keeps us from churning successfully-
  // completed historical removals.
  let currentRow = activeRow;
  let currentSchema = parseSerializedSchema(activeRow.schema_doc);
  while (currentRow.version > 1) {
    const priorRow = await backend.getSchemaVersion(
      graphId,
      currentRow.version - 1,
    );
    if (priorRow === undefined) break;
    const priorSchema = parseSerializedSchema(priorRow.schema_doc);

    for (const kindName of Object.keys(priorSchema.nodes)) {
      if (kindName in currentSchema.nodes) continue;
      if (recorded.has(kindRemovalKey("node", kindName, currentRow.version))) {
        continue;
      }
      reconciliations.push({
        kindName,
        entity: "node",
        schemaVersion: currentRow.version,
      });
    }
    for (const kindName of Object.keys(priorSchema.edges)) {
      if (kindName in currentSchema.edges) continue;
      if (recorded.has(kindRemovalKey("edge", kindName, currentRow.version))) {
        continue;
      }
      reconciliations.push({
        kindName,
        entity: "edge",
        schemaVersion: currentRow.version,
      });
    }

    currentRow = priorRow;
    currentSchema = priorSchema;
  }

  if (reconciliations.length === 0) return;

  const attemptedAt = nowIso();
  await Promise.all(
    reconciliations.map((r) =>
      recordKindRemoval({
        graphId,
        kindName: r.kindName,
        entity: r.entity,
        schemaVersion: r.schemaVersion,
        attemptedAt,
        removedAt: undefined,
        error: undefined,
      }),
    ),
  );
}

function kindRemovalKey(
  entity: "node" | "edge",
  kindName: string,
  version: number,
): string {
  return `${entity}|${kindName}|${version}`;
}

async function materializeOne(
  row: KindRemovalRow,
  ctx: Readonly<{
    backend: GraphBackend;
    graphId: string;
    nodesTable: string;
    edgesTable: string;
  }>,
): Promise<MaterializeRemovalsEntry> {
  const executeDdl = ctx.backend.executeDdl!;
  const recordKindRemoval = ctx.backend.recordKindRemoval!;
  try {
    // Build the per-row DELETEs. Nodes-of-this-kind plus the edges
    // table cleanup (edges referencing the kind via from_kind /
    // to_kind become orphans once the node is gone). Edge-kind
    // removal is the simpler single-table case. Independent
    // statements — issued in parallel.
    const deletes: Promise<void>[] = [];
    if (row.entity === "node") {
      deletes.push(
        executeDdl(
          `DELETE FROM ${quote(ctx.nodesTable)} WHERE graph_id = ${literal(ctx.graphId)} AND kind = ${literal(row.kindName)}`,
        ),
        executeDdl(
          `DELETE FROM ${quote(ctx.edgesTable)} WHERE graph_id = ${literal(ctx.graphId)} AND (from_kind = ${literal(row.kindName)} OR to_kind = ${literal(row.kindName)})`,
        ),
      );
    } else {
      deletes.push(
        executeDdl(
          `DELETE FROM ${quote(ctx.edgesTable)} WHERE graph_id = ${literal(ctx.graphId)} AND kind = ${literal(row.kindName)}`,
        ),
      );
    }
    await Promise.all(deletes);

    const removedAt = nowIso();
    await recordKindRemoval({
      graphId: ctx.graphId,
      kindName: row.kindName,
      entity: row.entity,
      schemaVersion: row.schemaVersion,
      attemptedAt: removedAt,
      removedAt,
      error: undefined,
    });
    return {
      kind: row.kindName,
      entity: row.entity,
      status: "removed",
    };
  } catch (error_) {
    const error = error_ instanceof Error ? error_ : new Error(String(error_));
    await recordKindRemoval({
      graphId: ctx.graphId,
      kindName: row.kindName,
      entity: row.entity,
      schemaVersion: row.schemaVersion,
      attemptedAt: nowIso(),
      removedAt: undefined,
      error: error.message,
    });
    return {
      kind: row.kindName,
      entity: row.entity,
      status: "failed",
      error,
    };
  }
}

// `executeDdl` accepts a raw SQL string. The DELETE statements built
// here are dialect-neutral (no SQLite/Postgres-specific syntax) and
// use single-quote string literals for graph_id / kind names. Both
// values come from the schema — never untrusted user input — but we
// still escape single quotes defensively to avoid surprises if a
// future kind-name validator narrows beyond `[A-Za-z_][A-Za-z0-9_]*`.
function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
