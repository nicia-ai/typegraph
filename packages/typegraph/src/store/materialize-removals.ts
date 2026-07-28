/**
 * Data-cleanup phase for `store.removeKinds()`.
 *
 * The removeKinds verb commits the new schema atomically (millisecond
 * budget); the data deletion happens here, scoped per-deployment via
 * the `typegraph_kind_removals` status table. Splitting the verbs
 * mirrors how `materializeIndexes` complements `evolve`: schema
 * commits are atomic and fast, while data work is bounded by row count and
 * deferrable. Candidates run sequentially because they share one graph lock.
 */
import { type RawBackend } from "../backend/branded";
import {
  type GraphBackend,
  type KindRemovalRow,
  type RecordKindRemovalParams,
  type SchemaVersionRow,
  type SchemaWriteTransactionBackend,
  type TransactionBackend,
} from "../backend/types";
import type { KindEntity } from "../core/types";
import { ConfigurationError } from "../errors";
import { createSqlSchema, type SqlSchema } from "../query/compiler/schema";
import type {
  VectorSlot,
  VectorStrategy,
} from "../query/dialect/vector-strategy";
import { sql } from "../query/sql-fragment";
import { asCompiledStatementSql } from "../query/sql-intent";
import { parseSerializedSchema } from "../schema/manager";
import type { SerializedSchema } from "../schema/types";
import { nowIso } from "../utils/date";
import { requireDefined } from "../utils/presence";
import { isMissingTableError } from "../utils/sql-errors";
import { ensureFocusedStatusTable } from "./materialize-shared";
import { closeRecordedHardDeletedKind } from "./recorded-capture";

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

/**
 * Outcome of one queued kind removal, discriminated on `status`.
 *
 * A union rather than one shape with optional fields, so each outcome carries
 * exactly its own payload: `"failed"` always has an `error`, `"skipped"`
 * always has a `reason`, and `"removed"` has neither. The flat form permitted
 * impossible states — a `"skipped"` with no reason, or a `"removed"` carrying
 * `reason: "kind-is-live"` — and narrowing on `status` still left both fields
 * optional at the use site.
 */
export type MaterializeRemovalsEntry =
  | Readonly<{ kind: string; entity: KindEntity; status: "removed" }>
  | Readonly<{
      kind: string;
      entity: KindEntity;
      status: "failed";
      error: Error;
    }>
  | Readonly<{
      kind: string;
      entity: KindEntity;
      status: "skipped";
      /**
       * `"kind-is-live"`: the active schema declares this kind again — it was
       * dropped, then re-added — so deleting its rows would destroy live
       * data. The queue row stays pending, so a later removal of the same
       * kind still reclaims it.
       *
       * Reported rather than silent: an empty `results` array would otherwise
       * be indistinguishable from "nothing was pending", leaving the queue at
       * a non-zero depth with nothing explaining why.
       */
      reason: "kind-is-live";
    }>;

/**
 * Outcome of reclaiming one per-`(graphId, kind, field)` vector table that
 * was orphaned when its embedding field was dropped from a *surviving*
 * kind's schema. Distinct from {@link MaterializeRemovalsEntry} (whole
 * kinds) because the unit is a single embedding field, not a kind.
 */
export type ReclaimedVectorFieldEntry = Readonly<{
  kind: string;
  fieldPath: string;
  status: "reclaimed" | "failed";
  error?: Error;
}>;

export type MaterializeRemovalsResult = Readonly<{
  results: readonly MaterializeRemovalsEntry[];
  /**
   * Embedding fields removed from a *surviving* kind whose per-field vector
   * table this pass dropped (or confirmed already absent). Empty when the
   * backend has no vector strategy or no embedding field has ever been
   * dropped. Re-derived from immutable schema history each call, so it lists
   * the same removed fields on repeat passes — the underlying drop is
   * idempotent (`DROP ... IF EXISTS`). See {@link reclaimRemovedVectorFieldTables}.
   */
  reclaimedVectorFields: readonly ReclaimedVectorFieldEntry[];
}>;

type MaterializeRemovalsContext = Readonly<{
  graphId: string;
  // Bulk kind-removal deletes live rows directly and closes recorded intervals
  // by kind — it deliberately bypasses the per-row capture wrapper, so it takes
  // the raw seam. Passing the graph-write backend here is a type error.
  backend: RawBackend;
  captureRecordedRemovals?: boolean;
  // The store's resolved SQL schema, so recorded-interval closes target the
  // same relations recorded reads do (honoring a custom `schema` option, not
  // just `backend.tableNames`). Falls back to the backend's table names.
  recordedSchema?: SqlSchema;
}>;

type MaterializeOneContext = Readonly<{
  backend: GraphBackend;
  graphId: string;
  nodesTable: string;
  edgesTable: string;
  fulltextTable: string;
  uniquesTable: string;
  captureRecordedRemovals: boolean;
  // Resolved once per removal pass (not per kind) and threaded into each
  // recorded-interval close. Undefined when recorded capture is off.
  recordedSchema: SqlSchema | undefined;
}>;

export async function materializeRemovals(
  context: MaterializeRemovalsContext,
  options: MaterializeRemovalsOptions = {},
): Promise<MaterializeRemovalsResult> {
  const { backend, graphId } = context;

  if (
    backend.recordKindRemoval === undefined ||
    backend.getPendingKindRemovals === undefined
  ) {
    throw new ConfigurationError(
      "store.materializeRemovals() requires a backend with kind-removal " +
        "primitives (recordKindRemoval, getPendingKindRemovals). " +
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

  // Independent of pending kind removals: a per-field vector table is
  // orphaned the moment its embedding field is dropped from a *surviving*
  // kind (an `evolve` that removes the field, with no kind removal at all).
  // The add-only `materializeIndexes` path never reclaims it and the
  // candidate loop below only handles whole kinds, so reclaim here before
  // the no-candidates short-circuit.
  // One read of the active schema, shared by the vector-reclaim candidate scan
  // and the live-kind candidate scan below. Both are optimizations only: each
  // destructive path repeats its liveness check under the schema-write lock.
  const activeRow = await backend.getActiveSchema(graphId);
  const activeSchema =
    activeRow === undefined ? undefined : (
      parseSerializedSchema(activeRow.schema_doc)
    );

  const reclaimedVectorFields = await reclaimRemovedVectorFieldTables(
    context,
    activeRow,
  );

  const pending = await backend.getPendingKindRemovals(graphId);

  // Never delete the rows of a kind the ACTIVE schema still declares.
  //
  // A pending removal only records that a kind was absent at some version. It
  // does not mean the kind is absent *now*: a drop at v3 followed by a re-add
  // at v4 leaves the v3 removal queued (and `reconcilePendingRemovals` keeps
  // re-deriving it from history, since that walk compares each consecutive
  // pair of documents and is blind to what happened later). Cleanup is an
  // unconditional `DELETE ... WHERE kind = ?`, so acting on that row would
  // destroy live data belonging to a kind applications are actively writing.
  //
  // Skipped rather than completed: the kind genuinely has not been cleaned up,
  // and leaving the row pending means a later removal of the same kind is
  // still reclaimed. Self-healing rather than sticky.
  //
  // This first read is an optimization only. `materializeOne` repeats the
  // liveness check while holding the schema-write lock and performs every row,
  // vector-table, and marker deletion in that same transaction. A re-add must
  // therefore commit either before the locked check (and be skipped) or after
  // cleanup commits.
  //
  // The decline is REPORTED (`status: "skipped"`), not silent. Queue depth is
  // the health signal for this subsystem, and a silent skip gives it a
  // legitimate non-zero steady state that no output explains — an operator
  // could not tell "nothing pending" from "declined on purpose".
  //
  // `reclaimRemovedVectorFieldTables` above independently keys its candidate
  // scan on the same active schema and repeats the field check under the same
  // lock before dropping storage — see the note there.
  const liveKinds = liveKindNamesFrom(activeSchema);

  const kindFilter =
    options.kinds === undefined ? undefined : new Set(options.kinds);
  const selected = pending.filter(
    (row) => kindFilter === undefined || kindFilter.has(row.kindName),
  );
  const candidates = selected.filter(
    (row) => !liveKinds[row.entity].has(row.kindName),
  );
  const skipped: readonly MaterializeRemovalsEntry[] = selected
    .filter((row) => liveKinds[row.entity].has(row.kindName))
    .map((row) => ({
      kind: row.kindName,
      entity: row.entity,
      status: "skipped" as const,
      reason: "kind-is-live" as const,
    }));

  if (candidates.length === 0) {
    return { results: skipped, reclaimedVectorFields };
  }

  const tableNames = backend.tableNames;
  const nodesTable = tableNames?.nodes ?? "typegraph_nodes";
  const edgesTable = tableNames?.edges ?? "typegraph_edges";
  const fulltextTable = tableNames?.fulltext ?? "typegraph_node_fulltext";
  const uniquesTable = tableNames?.uniques ?? "typegraph_node_uniques";

  const captureRecordedRemovals = context.captureRecordedRemovals === true;
  const ctx = {
    backend,
    graphId,
    nodesTable,
    edgesTable,
    fulltextTable,
    uniquesTable,
    captureRecordedRemovals,
    recordedSchema:
      captureRecordedRemovals ?
        (context.recordedSchema ?? createSqlSchema(backend.tableNames))
      : undefined,
  } as const;

  // Every candidate takes the same per-graph schema-write lock. Running them
  // concurrently only consumes pool connections while all but one wait, so
  // process candidates sequentially. Best-effort mode continues after failed
  // entries; `stopOnError` short-circuits after the first failure.
  const materialized: MaterializeRemovalsEntry[] = [];
  for (const candidate of candidates) {
    const entry = await materializeOne(candidate, ctx);
    materialized.push(entry);
    if (options.stopOnError === true && entry.status === "failed") break;
  }
  return { results: [...materialized, ...skipped], reclaimedVectorFields };
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
    requireDefined(backend.getPendingKindRemovals)(graphId)
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

/**
 * Node and edge kind names the active schema declares, by entity.
 *
 * Used to refuse cleanup for a kind that has since been re-added. Returns
 * empty sets when no schema is committed — nothing is live, so nothing is
 * protected, and the pending rows proceed as before.
 */
function liveKindNamesFrom(
  schema: SerializedSchema | undefined,
): Readonly<Record<KindEntity, ReadonlySet<string>>> {
  if (schema === undefined) {
    return { node: new Set<string>(), edge: new Set<string>() };
  }
  return {
    node: new Set(Object.keys(schema.nodes)),
    edge: new Set(Object.keys(schema.edges)),
  };
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
  ctx: MaterializeOneContext,
): Promise<MaterializeRemovalsEntry> {
  const recordKindRemoval = requireDefined(ctx.backend.recordKindRemoval);
  const schemaWriteTransaction = ctx.backend.schemaWriteTransaction;
  if (schemaWriteTransaction === undefined) {
    throw new ConfigurationError(
      "store.materializeRemovals() requires a backend that can hold the " +
        "schema-write lock across the live-kind check and cleanup.",
      { code: "MATERIALIZE_REMOVALS_SCHEMA_FENCE_UNSUPPORTED" },
    );
  }
  try {
    const outcome = await schemaWriteTransaction(
      ctx.graphId,
      async (target): Promise<"removed" | "skipped"> => {
        const activeRow = await target.getActiveSchema(ctx.graphId);
        const activeSchema =
          activeRow === undefined ? undefined : (
            parseSerializedSchema(activeRow.schema_doc)
          );
        if (liveKindNamesFrom(activeSchema)[row.entity].has(row.kindName)) {
          return "skipped";
        }

        await closeRecordedAndDeleteLiveRows(ctx, row, target);
        await dropEmbeddingTableStorage(ctx, row, target);
        return "removed";
      },
    );

    if (outcome === "skipped") {
      return {
        kind: row.kindName,
        entity: row.entity,
        status: "skipped",
        reason: "kind-is-live",
      };
    }

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

/**
 * Closes recorded-time intervals for a hard-removed kind and deletes the live
 * rows in one transaction. Without the shared transaction, a crash after the
 * recorded close but before the live deletes leaves broad live reads able to see
 * rows whose kind the active schema has removed.
 *
 * Tolerates absent recorded relations exactly as `clear()` and
 * `refreshStatistics()` do: a history-enabled store whose recorded tables
 * predate recorded-time history (bring-your-own-pool, no DDL re-run) skips only
 * the close, then still deletes the live rows. A transaction-bound catalog
 * preflight avoids issuing a statement that would abort PostgreSQL and avoids
 * raw transaction framing, which Durable Object SQLite forbids. A no-op close
 * when recorded-removal capture is off.
 */
async function closeRecordedAndDeleteLiveRows(
  ctx: MaterializeOneContext,
  row: KindRemovalRow,
  target: SchemaWriteTransactionBackend,
): Promise<void> {
  const deleteStatements = buildRemovedKindLiveDeleteStatements(ctx, row);
  if (!ctx.captureRecordedRemovals || ctx.recordedSchema === undefined) {
    await executeDeleteStatements(target, deleteStatements);
    return;
  }

  const recordedSchema = ctx.recordedSchema;
  const requiredRecordedTables = [
    recordedSchema.tables.recordedClock,
    recordedSchema.tables.recordedEdges,
    ...(row.entity === "node" ? [recordedSchema.tables.recordedNodes] : []),
  ];
  const recordedTablesExist = await Promise.all(
    requiredRecordedTables.map((tableName) => target.tableExists(tableName)),
  );
  if (recordedTablesExist.some((exists) => !exists)) {
    await executeDeleteStatements(target, deleteStatements);
    return;
  }

  await closeRecordedHardDeletedKind(
    target,
    recordedSchema,
    ctx.graphId,
    { entity: row.entity, kind: row.kindName },
    false,
  );
  await executeDeleteStatements(target, deleteStatements);
}

function buildRemovedKindLiveDeleteStatements(
  ctx: MaterializeOneContext,
  row: KindRemovalRow,
): readonly string[] {
  const graphLit = literal(ctx.graphId);
  const kindLit = literal(row.kindName);
  if (row.entity === "node") {
    return [
      `DELETE FROM ${quote(ctx.nodesTable)} WHERE graph_id = ${graphLit} AND kind = ${kindLit}`,
      `DELETE FROM ${quote(ctx.edgesTable)} WHERE graph_id = ${graphLit} AND (from_kind = ${kindLit} OR to_kind = ${kindLit})`,
      `DELETE FROM ${quote(ctx.fulltextTable)} WHERE graph_id = ${graphLit} AND node_kind = ${kindLit}`,
      `DELETE FROM ${quote(ctx.uniquesTable)} WHERE graph_id = ${graphLit} AND node_kind = ${kindLit}`,
    ];
  }
  return [
    `DELETE FROM ${quote(ctx.edgesTable)} WHERE graph_id = ${graphLit} AND kind = ${kindLit}`,
  ];
}

async function executeDeleteStatements(
  target: SchemaWriteTransactionBackend,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) {
    await target.executeStatement(asCompiledStatementSql(sql.raw(statement)));
  }
}

/**
 * Builds the embedding-storage cleanup for a removed node kind.
 *
 * With per-`(graphId, kind, field)` storage there is no single shared
 * embeddings table to filter by `node_kind`; each embedding field of the
 * removed kind has its own typed, graph-scoped table. We resolve those fields
 * from the schema version that still *had* the kind (`schemaVersion - 1`) and
 * drop each per-field table via the strategy — the same teardown the
 * removed-*field* reclamation uses — so the kind's table and any ANN index it
 * owns are fully reclaimed (a stale empty table would otherwise collide with a
 * re-added kind at a different dimension).
 *
 * Backends without a vector strategy, or schema history that can't be
 * read, yield no cleanup — there is no embedding storage to reclaim.
 */
async function dropEmbeddingTableStorage(
  ctx: Readonly<{
    backend: GraphBackend;
    graphId: string;
  }>,
  row: KindRemovalRow,
  target: SchemaWriteTransactionBackend,
): Promise<void> {
  const vectorStrategy = ctx.backend.vectorStrategy;
  if (vectorStrategy === undefined) return;

  const executeDdl = target.executeSchemaDdl;
  const deleteContribution = target.deleteSchemaVectorSlotContribution;
  const slots = await resolveRemovedKindEmbeddingSlots(target, row);
  for (const slot of slots) {
    await dropVectorSlotStorage(vectorStrategy, executeDdl, slot);
    await deleteContribution(slot);
  }
}

/**
 * Drops a per-field vector slot's storage via the strategy (table + any ANN
 * index it owns), tolerating an already-absent table — a declared field whose
 * per-field table was never materialized (no write, no index build) has nothing
 * to reclaim. The caller supplies the schema transaction's DDL executor so the
 * storage drop and marker deletion commit or roll back together. Shared by
 * removed-kind cleanup and removed-field reclamation so both reclaim storage
 * the same way.
 */
async function dropVectorSlotStorage(
  strategy: VectorStrategy,
  executeDdl: (statement: string) => Promise<void>,
  slot: VectorSlot,
): Promise<void> {
  try {
    for (const ddl of strategy.buildDropStorage(slot)) {
      await executeDdl(ddl);
    }
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
  }
}

/**
 * Resolves the embedding field paths a removed node kind declared, read
 * from the persisted vector index declarations in the schema version
 * just before the removal (`schemaVersion - 1`). Returns `[]` when the
 * prior version is unavailable or declared no embedding fields for the
 * kind.
 */
async function resolveRemovedKindEmbeddingSlots(
  backend: GraphBackend | TransactionBackend,
  row: KindRemovalRow,
): Promise<readonly VectorSlot[]> {
  const priorVersion = row.schemaVersion - 1;
  if (priorVersion < 1) return [];
  const priorRow = await backend.getSchemaVersion(row.graphId, priorVersion);
  if (priorRow === undefined) return [];

  const priorSchema = parseSerializedSchema(priorRow.schema_doc);
  const slots = new Map<string, VectorSlot>();
  for (const declaration of priorSchema.indexes ?? []) {
    if (declaration.entity === "vector" && declaration.kind === row.kindName) {
      slots.set(declaration.fieldPath, {
        graphId: row.graphId,
        nodeKind: row.kindName,
        fieldPath: declaration.fieldPath,
        dimensions: declaration.dimensions,
        metric: declaration.metric,
        indexType: declaration.indexType,
      });
    }
  }
  return [...slots.values()];
}

/** Stable key for a `(kind, fieldPath)` embedding-field pair. */
function vectorFieldKey(kind: string, fieldPath: string): string {
  return `${kind}\u0000${fieldPath}`;
}

function vectorFieldKeysFrom(schema: SerializedSchema): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const declaration of schema.indexes ?? []) {
    if (declaration.entity === "vector") {
      keys.add(vectorFieldKey(declaration.kind, declaration.fieldPath));
    }
  }
  return keys;
}

/**
 * The historical declaration of a vector field, carrying everything
 * {@link VectorStrategy.buildDropStorage} needs to tear the storage down —
 * notably `indexType`, which libSQL reads to also drop its DiskANN index.
 */
type HistoricalVectorField = Readonly<{
  kind: string;
  fieldPath: string;
  slot: VectorSlot;
}>;

/**
 * Reclaims per-`(graphId, kind, field)` vector tables orphaned by embedding-
 * field removals on *surviving* kinds.
 *
 * Per-field storage means every embedding field owns a typed table. When a
 * field is dropped from a kind that still exists (an `evolve` that removes the
 * embedding), nothing reclaims that table: the add-only `materializeIndexes`
 * path ignores removals and the kind-scoped cleanup above only fires for whole
 * removed kinds. Left alone the table lingers with dead rows that no query
 * reads again, and — worse — a later re-add of the field at a different
 * dimension would collide with the stale table.
 *
 * The orphan set is derived from schema history: every vector field ever
 * declared, minus the ones still declared in the *active* schema, restricted
 * to kinds that still exist (removed-kind fields are the kind path's job).
 * The initial active-schema read only finds candidates. Each candidate is
 * rechecked while holding the schema-write lock, and its DDL plus durable
 * marker deletion run in that same transaction. A re-add therefore commits
 * either before the locked check (and is skipped) or after cleanup commits.
 * `buildDropStorage` emits `DROP ... IF EXISTS`, so the pass is idempotent and
 * a never-materialized field is a clean no-op; deriving from full history each
 * call also reclaims tables orphaned before this shipped.
 *
 * Backends without a vector strategy have no per-field tables to reclaim and
 * yield an empty result.
 */
async function reclaimRemovedVectorFieldTables(
  context: MaterializeRemovalsContext,
  activeRow: SchemaVersionRow | undefined,
): Promise<readonly ReclaimedVectorFieldEntry[]> {
  const { backend, graphId } = context;
  const vectorStrategy = backend.vectorStrategy;
  if (vectorStrategy === undefined) return [];
  if (activeRow === undefined) return [];

  // The orphan set is a pure function of (graphId, active version) over
  // immutable schema history and the drops are idempotent, so re-walking the
  // whole history on every materializeRemovals call is wasted O(versions) work.
  // Memoize per (backend, graphId:version); an evolve bumps the version and
  // invalidates. Only fully-successful passes are cached (a failed drop must be
  // retried), and the cache is in-process so a fresh backend re-walks once.
  const cacheKey = `${graphId}\u0000${activeRow.version}`;
  let perBackend = reclaimCache.get(backend);
  const cached = perBackend?.get(cacheKey);
  if (cached !== undefined) return cached;

  const activeSchema = parseSerializedSchema(activeRow.schema_doc);

  const activeVectorFields = vectorFieldKeysFrom(activeSchema);
  const survivingKinds = new Set(Object.keys(activeSchema.nodes));

  // Walk history backward, keeping the most-recent declaration of each
  // vector field (first seen wins) so `buildDropStorage` gets a faithful
  // `indexType`/`dimensions`.
  const historical = new Map<string, HistoricalVectorField>();
  for (let version = activeRow.version - 1; version >= 1; version -= 1) {
    const priorRow = await backend.getSchemaVersion(graphId, version);
    if (priorRow === undefined) continue;
    const priorSchema = parseSerializedSchema(priorRow.schema_doc);
    for (const declaration of priorSchema.indexes ?? []) {
      if (declaration.entity !== "vector") continue;
      const key = vectorFieldKey(declaration.kind, declaration.fieldPath);
      if (historical.has(key)) continue;
      historical.set(key, {
        kind: declaration.kind,
        fieldPath: declaration.fieldPath,
        slot: {
          graphId,
          nodeKind: declaration.kind,
          fieldPath: declaration.fieldPath,
          dimensions: declaration.dimensions,
          metric: declaration.metric,
          indexType: declaration.indexType,
        },
      });
    }
  }

  // Both clauses key on the ACTIVE schema to keep the candidate set narrow:
  // `survivingKinds` requires the kind to be live now, so a re-added kind with
  // its field re-declared is not an orphan, and a still-removed kind is left
  // to the candidate loop in `materializeRemovals` instead.
  //
  // This scan is not the safety boundary: a schema commit can land after it.
  // The per-field transaction below re-reads the same authority under the
  // schema-write lock before issuing DDL.
  const orphans = [...historical.values()].filter(
    (field) =>
      !activeVectorFields.has(vectorFieldKey(field.kind, field.fieldPath)) &&
      survivingKinds.has(field.kind),
  );

  const results: ReclaimedVectorFieldEntry[] = [];
  let skippedAfterLockedRecheck = false;
  const schemaWriteTransaction = backend.schemaWriteTransaction;
  if (orphans.length > 0 && schemaWriteTransaction === undefined) {
    throw new ConfigurationError(
      "store.materializeRemovals() requires a backend that can hold the " +
        "schema-write lock across the vector-field liveness check and cleanup.",
      { code: "MATERIALIZE_REMOVALS_SCHEMA_FENCE_UNSUPPORTED" },
    );
  }
  for (const field of orphans) {
    try {
      const reclaimed = await requireDefined(schemaWriteTransaction)(
        graphId,
        async (target): Promise<boolean> => {
          const lockedActiveRow = await target.getActiveSchema(graphId);
          if (lockedActiveRow === undefined) return false;
          const lockedActiveSchema = parseSerializedSchema(
            lockedActiveRow.schema_doc,
          );
          const lockedVectorFields = vectorFieldKeysFrom(lockedActiveSchema);
          if (
            lockedVectorFields.has(
              vectorFieldKey(field.kind, field.fieldPath),
            ) ||
            !Object.hasOwn(lockedActiveSchema.nodes, field.kind)
          ) {
            return false;
          }

          await dropVectorSlotStorage(
            vectorStrategy,
            target.executeSchemaDdl,
            field.slot,
          );
          await target.deleteSchemaVectorSlotContribution(field.slot);
          return true;
        },
      );
      if (!reclaimed) {
        skippedAfterLockedRecheck = true;
        continue;
      }
      results.push({
        kind: field.kind,
        fieldPath: field.fieldPath,
        status: "reclaimed",
      });
    } catch (error) {
      results.push({
        kind: field.kind,
        fieldPath: field.fieldPath,
        status: "failed",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  // Cache only a fully-successful pass — a failed drop must be retried.
  if (
    !skippedAfterLockedRecheck &&
    results.every((entry) => entry.status === "reclaimed")
  ) {
    if (perBackend === undefined) {
      perBackend = new Map();
      reclaimCache.set(backend, perBackend);
    }
    perBackend.set(cacheKey, results);
  }
  return results;
}

/**
 * In-process memo for {@link reclaimRemovedVectorFieldTables}, keyed by backend
 * then `graphId:activeVersion`. See that function for why version-keying is
 * sound (the orphan set is a pure function of immutable history + the version).
 */
const reclaimCache = new WeakMap<
  GraphBackend,
  Map<string, readonly ReclaimedVectorFieldEntry[]>
>();

// The DELETE statements built here are dialect-neutral and use no
// SQLite/Postgres-specific syntax. They use single-quote string literals for
// graph_id / kind names. Both
// values come from the schema — never untrusted user input — but we
// still escape single quotes defensively to avoid surprises if a
// future kind-name validator narrows beyond `[A-Za-z_][A-Za-z0-9_]*`.
function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
