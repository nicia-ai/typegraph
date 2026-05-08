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
import {
  type GraphBackend,
  type KindRemovalRow,
  type RecordKindRemovalParams,
} from "../backend/types";
import type { KindEntity } from "../core/types";
import { ConfigurationError } from "../errors";
import { parseSerializedSchema } from "../schema/manager";
import { nowIso } from "../utils/date";
import {
  ensureFocusedStatusTable,
  runMaterialization,
} from "./materialize-shared";

const ENTITY_KINDS: readonly KindEntity[] = ["node", "edge"];

/**
 * Build the "pending" `recordKindRemoval` payload shared by
 * `Store.removeKinds` (the original commit-time write) and
 * `materializeRemovals` reconciliation (the catch-up write for kinds
 * that crashed before their queue row landed). Centralizes the
 * `removedAt: undefined, error: undefined` constants so a future
 * status-table column expansion has one site to update.
 */
export function buildPendingKindRemoval(
  args: Readonly<{
    graphId: string;
    kindName: string;
    entity: KindEntity;
    schemaVersion: number;
    attemptedAt: string;
  }>,
): RecordKindRemovalParams {
  return { ...args, removedAt: undefined, error: undefined };
}

export type MaterializeRemovalsOptions = Readonly<{
  /** Restrict to specific kind names. */
  kinds?: readonly string[];
  /** Halt on first failure. Default: false (best-effort). */
  stopOnError?: boolean;
}>;

export type MaterializeRemovalsEntry = Readonly<{
  kind: string;
  entity: KindEntity;
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

  await ensureFocusedStatusTable(backend, backend.ensureKindRemovalsTable);

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
  const embeddingsTable = tableNames?.embeddings ?? "typegraph_node_embeddings";
  const fulltextTable = tableNames?.fulltext ?? "typegraph_node_fulltext";
  const uniquesTable = tableNames?.uniques ?? "typegraph_node_uniques";

  const ctx = {
    backend,
    graphId,
    nodesTable,
    edgesTable,
    embeddingsTable,
    fulltextTable,
    uniquesTable,
  } as const;

  // Each kind targets a disjoint row set (DELETEs filtered by kindName),
  // so the default best-effort path runs them concurrently — Postgres
  // parallelizes round-trips across pool connections, SQLite serializes
  // writes at the engine level either way. `stopOnError` honors strict
  // sequential semantics; the first failure short-circuits the rest.
  return {
    results: await runMaterialization(candidates, options, (removal) =>
      materializeOne(removal, ctx),
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

  // Watermark short-circuit: when a previous reconciliation pass
  // verified history through some version M, only walk transitions
  // newer than M. Without the watermark this loop walked from active
  // down to version 1 on every call — N round-trips + N Zod parses
  // per call — and re-verified already-good history every time.
  // Backends without the marker primitives fall back to walking from
  // version 1 (the legacy behavior) so existing custom backends
  // keep working.
  //
  // Bootstrap the marker table BEFORE the read — DBs that pre-date
  // this slice would otherwise SELECT from a missing table and throw
  // before they got the chance to create it.
  if (backend.ensureReconciliationMarkersTable !== undefined) {
    await backend.ensureReconciliationMarkersTable();
  }
  const marker =
    backend.getReconciliationMarker === undefined ?
      undefined
    : await backend.getReconciliationMarker(graphId);
  if (marker !== undefined && marker >= activeRow.version) return;

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
    entity: KindEntity;
    schemaVersion: number;
  }[] = [];

  // Walk backward through transitions, stopping at the watermark.
  // At each pair (priorRow, currentRow) we compute "kinds removed at
  // currentRow.version" and check the existence map — any missing
  // entry needs an idempotent upsert. The marker bounds the walk so
  // long-running deployments with hundreds of schema versions skip
  // the bulk of the round-trips after their first reconciliation.
  const stopAtVersion = marker ?? 1;
  let currentRow = activeRow;
  let currentSchema = parseSerializedSchema(activeRow.schema_doc);
  while (currentRow.version > stopAtVersion) {
    const priorRow = await backend.getSchemaVersion(
      graphId,
      currentRow.version - 1,
    );
    if (priorRow === undefined) break;
    const priorSchema = parseSerializedSchema(priorRow.schema_doc);

    for (const entity of ENTITY_KINDS) {
      const priorEntries = priorSchema[entity === "node" ? "nodes" : "edges"];
      const currentEntries =
        currentSchema[entity === "node" ? "nodes" : "edges"];
      for (const kindName of Object.keys(priorEntries)) {
        if (kindName in currentEntries) continue;
        if (
          recorded.has(kindRemovalKey(entity, kindName, currentRow.version))
        ) {
          continue;
        }
        reconciliations.push({
          kindName,
          entity,
          schemaVersion: currentRow.version,
        });
      }
    }

    currentRow = priorRow;
    currentSchema = priorSchema;
  }

  if (reconciliations.length > 0) {
    const attemptedAt = nowIso();
    await Promise.all(
      reconciliations.map((entry) =>
        recordKindRemoval(
          buildPendingKindRemoval({
            graphId,
            kindName: entry.kindName,
            entity: entry.entity,
            schemaVersion: entry.schemaVersion,
            attemptedAt,
          }),
        ),
      ),
    );
  }

  // Persist the new high-water mark so the next call walks only
  // versions newer than this one. Done after the reconciliation
  // upserts succeed — a crash before this point leaves the marker
  // unchanged, so the next call re-walks (idempotent — recorded
  // rows skip via the existence-map check above).
  if (backend.setReconciliationMarker !== undefined) {
    await backend.setReconciliationMarker(graphId, activeRow.version);
  }
}

function kindRemovalKey(
  entity: KindEntity,
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
    embeddingsTable: string;
    fulltextTable: string;
    uniquesTable: string;
  }>,
): Promise<MaterializeRemovalsEntry> {
  const executeDdl = ctx.backend.executeDdl!;
  const recordKindRemoval = ctx.backend.recordKindRemoval!;
  try {
    // Build the per-row DELETEs. For a removed node kind: drop the
    // primary rows, every edge referencing it (via from_kind / to_kind
    // — those would otherwise dangle), plus the secondary tables that
    // partition by node_kind (embeddings, fulltext, uniques). Without
    // the secondary cleanup, repeated remove/re-add cycles accumulate
    // dead rows that vector / fulltext / unique lookups still scan.
    // For a removed edge kind: only the edges table needs cleanup.
    // All statements target disjoint row sets — issued in parallel.
    const deletes: Promise<void>[] = [];
    const graphLit = literal(ctx.graphId);
    const kindLit = literal(row.kindName);
    if (row.entity === "node") {
      deletes.push(
        executeDdl(
          `DELETE FROM ${quote(ctx.nodesTable)} WHERE graph_id = ${graphLit} AND kind = ${kindLit}`,
        ),
        executeDdl(
          `DELETE FROM ${quote(ctx.edgesTable)} WHERE graph_id = ${graphLit} AND (from_kind = ${kindLit} OR to_kind = ${kindLit})`,
        ),
        executeDdl(
          `DELETE FROM ${quote(ctx.embeddingsTable)} WHERE graph_id = ${graphLit} AND node_kind = ${kindLit}`,
        ),
        executeDdl(
          `DELETE FROM ${quote(ctx.fulltextTable)} WHERE graph_id = ${graphLit} AND node_kind = ${kindLit}`,
        ),
        executeDdl(
          `DELETE FROM ${quote(ctx.uniquesTable)} WHERE graph_id = ${graphLit} AND node_kind = ${kindLit}`,
        ),
      );
    } else {
      deletes.push(
        executeDdl(
          `DELETE FROM ${quote(ctx.edgesTable)} WHERE graph_id = ${graphLit} AND kind = ${kindLit}`,
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
