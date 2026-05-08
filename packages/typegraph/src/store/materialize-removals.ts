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
