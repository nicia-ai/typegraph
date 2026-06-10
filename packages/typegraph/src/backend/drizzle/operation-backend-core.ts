import { is, type SQL } from "drizzle-orm";

import {
  ConfigurationError,
  DatabaseOperationError,
  MigrationError,
  SchemaContentConflictError,
  StaleVersionError,
  UniquenessError,
} from "../../errors";
import { generateId } from "../../utils/id";
import type {
  CheckUniqueBatchParams,
  CheckUniqueParams,
  CommitSchemaVersionParams,
  CountEdgesByKindParams,
  CountEdgesFromParams,
  CountNodesByKindParams,
  DeleteEdgeParams,
  DeleteNodeParams,
  DeleteUniqueParams,
  EdgeExistsBetweenParams,
  EdgeRow,
  FindEdgesByKindParams,
  FindEdgesConnectedToParams,
  FindNodesByKindParams,
  HardDeleteEdgeParams,
  HardDeleteNodeParams,
  HistoryOp,
  InsertEdgeParams,
  InsertNodeParams,
  InsertUniqueParams,
  NodeRow,
  SchemaVersionRow,
  SetActiveVersionParams,
  TransactionBackend,
  UniqueRow,
  UpdateEdgeParams,
  UpdateNodeParams,
} from "../types";
import {
  type EdgePreImage,
  type HistoryAudit,
  type HistoryStrategy,
  type NodePreImage,
} from "./operations/history";
import { type CommonOperationStrategy } from "./operations/strategy";
import { nowIso as defaultNowIso } from "./row-mappers";

/**
 * The internal operation backend — what `createCommonOperationBackend`
 * returns. Includes `commitSchemaVersion` and `setActiveVersion` so the
 * top-level backend wrappers can call them on a fresh tx-scoped
 * operation backend (created inside the dialect-specific
 * write-locking transaction). These methods are deliberately NOT on
 * the public `TransactionBackend` type — see the comment there.
 */
export type CommonOperationBackend = Pick<
  TransactionBackend,
  | "checkUnique"
  | "checkUniqueBatch"
  | "clearGraph"
  | "countEdgesByKind"
  | "countEdgesFrom"
  | "countNodesByKind"
  | "deleteEdge"
  | "deleteNode"
  | "deleteUnique"
  | "edgeExistsBetween"
  | "findEdgesByKind"
  | "findEdgesConnectedTo"
  | "findNodesByKind"
  | "getActiveSchema"
  | "getEdge"
  | "getEdges"
  | "getNode"
  | "getNodes"
  | "getSchemaVersion"
  | "hardDeleteEdge"
  | "hardDeleteNode"
  | "insertEdge"
  | "insertEdgeNoReturn"
  | "insertEdgesBatch"
  | "insertEdgesBatchReturning"
  | "insertNode"
  | "insertNodeNoReturn"
  | "insertNodesBatch"
  | "insertNodesBatchReturning"
  | "insertUnique"
  | "updateEdge"
  | "updateNode"
> &
  Readonly<{
    commitSchemaVersion: (
      params: CommitSchemaVersionParams,
    ) => Promise<SchemaVersionRow>;
    setActiveVersion: (params: SetActiveVersionParams) => Promise<void>;
  }>;

/**
 * The full internal shape the dialect operation-backend factories
 * build: a {@link TransactionBackend} that also exposes the schema-write
 * methods ({@link CommonOperationBackend}). Internal callers holding the
 * dialect's write-lock (`runSchemaWriteTransaction`) use it directly;
 * the public `transaction()` / `adoptTransaction()` boundary narrows it
 * to `TransactionBackend` so user callbacks can't reach
 * `commitSchemaVersion` / `setActiveVersion` and bypass the lock.
 */
export type InternalOperationBackend = TransactionBackend &
  CommonOperationBackend;

/**
 * Assert an externally-supplied transaction handle is the expected
 * Drizzle dialect, narrowing it for `adoptTransaction`. A wrong-dialect
 * handle would otherwise surface as an opaque driver error mid-
 * transaction; this fails it loudly at the boundary instead.
 */
export function assertAdoptedDialect<T>(
  externalTx: unknown,
  brand: Parameters<typeof is>[1],
  backend: "postgres" | "sqlite",
): asserts externalTx is T {
  if (is(externalTx, brand)) return;
  const label = backend === "postgres" ? "Postgres" : "SQLite";
  throw new ConfigurationError(
    `adoptTransaction received a handle that is not a ${label} Drizzle ` +
      `transaction. Pass the \`tx\` from a ${label} ` +
      `\`db.transaction(...)\` opened on this backend's connection.`,
    { backend, capability: "adoptTransaction" },
  );
}

type OperationBackendExecution = Readonly<{
  execAll: <TRow>(query: SQL) => Promise<readonly TRow[]>;
  execGet: <TRow>(query: SQL) => Promise<TRow | undefined>;
  execRun: (query: SQL) => Promise<void>;
  /**
   * Execute a sequence of statements atomically and return the rows of the
   * LAST statement when `lastReturnsRows` (the mutation's RETURNING). The
   * new F1a seam (D4): used only by the SQLite atomic capture path, which
   * emits `[capture, mutation]`. At the implicit-op level the SQLite
   * adapter wraps the pair in a driver transaction; inside an existing
   * transaction it runs them sequentially on the bound connection. The
   * `lastReturnsRows` flag picks the driver call (better-sqlite3 throws on
   * `.all()` against a statement without RETURNING). Postgres never needs
   * this — its capture is one data-modifying CTE.
   */
  runMany?: <TRow>(
    queries: readonly SQL[],
    lastReturnsRows: boolean,
  ) => Promise<readonly TRow[]>;
}>;

/**
 * History-capture configuration handed to the backend core when
 * `createStore(..., { history: true })` enables recorded-time capture
 * (F1a). Absent (or `isEnabled()` false) → the core emits byte-identical
 * mutation SQL with no capture statements.
 */
export type HistoryCoreConfig = Readonly<{
  isEnabled: () => boolean;
  /**
   * `"atomic"`: a history row commits iff its mutation commits (Postgres
   * CTE, or SQLite `runMany` / an enclosing transaction). `"best-effort"`:
   * non-transactional backends (SQLite `transactionMode: "none"`) — the
   * mutation runs first and the history row is written second, never
   * fabricating a phantom transition.
   */
  mode: "atomic" | "best-effort";
  strategy: HistoryStrategy;
  /**
   * Per-graph cache of the active schema version stamped on every history
   * row. Shared across the top-level and tx-scoped cores (so a schema
   * commit invalidates it for all), but the cold-read uses THIS core's own
   * execution — inside a transaction that reads on the tx connection,
   * avoiding a cross-connection deadlock on single-connection drivers.
   */
  schemaVersionCache: Map<string, number>;
  /**
   * The audit context for captures by THIS core. Tx-scoped cores return a
   * fixed `{ txId, meta }` for the whole transaction; the top-level core
   * returns a fresh `txId` per call (one per implicit op), `meta`
   * undefined. Called once per mutation method so a hard-delete cascade
   * groups its node + edge captures under one `txId`.
   */
  nextContext: () => Readonly<{ txId: string; meta: string | undefined }>;
}>;

/**
 * History capture pieces shared by a backend and every transaction-scoped
 * child (F1a). `state.enabled` is a single mutable flag flipped by
 * `createStore(..., { history: true })`; `mode` is `"atomic"` unless the
 * backend can't wrap the capture pair; `activeSchemaVersion` returns the
 * cached active version stamped on each history row.
 */
export type HistoryWiring = Readonly<{
  state: { enabled: boolean };
  strategy: HistoryStrategy;
  mode: "atomic" | "best-effort";
  /** Shared per-graph active-schema-version cache (stamped on history rows). */
  schemaVersionCache: Map<string, number>;
}>;

/** The per-transaction audit context (one tx_id + serialized meta). */
export type HistoryContext = Readonly<{
  txId: string;
  meta: string | undefined;
}>;

/**
 * Builds the {@link HistoryCoreConfig} the backend core consumes. A fixed
 * `context` (tx-scoped backends) stamps one tx_id for the whole
 * transaction; without it (the outer backend) each implicit op gets a
 * fresh tx_id.
 */
export function buildHistoryCoreConfig(
  wiring: HistoryWiring,
  context: HistoryContext | undefined,
): HistoryCoreConfig {
  return {
    isEnabled: () => wiring.state.enabled,
    mode: wiring.mode,
    strategy: wiring.strategy,
    schemaVersionCache: wiring.schemaVersionCache,
    nextContext: () => context ?? { txId: generateId(), meta: undefined },
  };
}

type OperationBackendBatchConfig = Readonly<{
  checkUniqueBatchChunkSize: number;
  edgeInsertBatchSize: number;
  getEdgesChunkSize: number;
  getNodesChunkSize: number;
  nodeInsertBatchSize: number;
}>;

type OperationBackendRowMappers = Readonly<{
  toEdgeRow: (row: Record<string, unknown>) => EdgeRow;
  toNodeRow: (row: Record<string, unknown>) => NodeRow;
  toSchemaVersionRow: (row: Record<string, unknown>) => SchemaVersionRow;
  toUniqueRow: (row: Record<string, unknown>) => UniqueRow;
}>;

type CreateCommonOperationBackendOptions = Readonly<{
  batchConfig: OperationBackendBatchConfig;
  execution: OperationBackendExecution;
  nowIso?: (() => string) | undefined;
  operationStrategy: CommonOperationStrategy;
  rowMappers: OperationBackendRowMappers;
  /** Recorded-time history capture (F1a). Absent → capture disabled. */
  history?: HistoryCoreConfig | undefined;
}>;

function chunkArray<T>(
  values: readonly T[],
  size: number,
): readonly (readonly T[])[] {
  if (values.length <= size) {
    return [values];
  }

  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function verifyExpectedActiveVersion(
  graphId: string,
  expected: CommitSchemaVersionParams["expected"],
  actualActiveVersion: number,
): void {
  const expectedVersion = expected.kind === "active" ? expected.version : 0;
  if (actualActiveVersion !== expectedVersion) {
    throw new StaleVersionError({
      graphId,
      expected: expectedVersion,
      actual: actualActiveVersion,
    });
  }
}

export function createCommonOperationBackend(
  options: CreateCommonOperationBackendOptions,
): CommonOperationBackend {
  const { batchConfig, execution, operationStrategy, rowMappers } = options;
  const nowIso = options.nowIso ?? defaultNowIso;

  // Returns 0 when no row is currently active — that's the sentinel
  // `expected: { kind: "initial" }` matches against.
  async function readActiveVersion(graphId: string): Promise<number> {
    const row = await execution.execGet<Record<string, unknown>>(
      operationStrategy.buildGetActiveSchema(graphId),
    );
    return row === undefined ? 0 : rowMappers.toSchemaVersionRow(row).version;
  }

  // === History capture (F1a) ===
  //
  // All capture helpers are no-ops unless `history` is configured AND
  // enabled (the store opt-in). When disabled, every mutation method runs
  // its existing single statement, so the compiled SQL is byte-identical.
  const history = options.history;

  function historyActive(): boolean {
    return history?.isEnabled() === true;
  }

  async function makeAudit(
    graphId: string,
    op: HistoryOp,
    recordedTo: string,
  ): Promise<HistoryAudit> {
    const context = history!.nextContext();
    // Stamp the active schema version, cached per graph. The cold read uses
    // this core's own execution (the tx connection inside a transaction),
    // so a single-connection driver never deadlocks against its own tx.
    const cache = history!.schemaVersionCache;
    let schemaVersion = cache.get(graphId);
    if (schemaVersion === undefined) {
      schemaVersion = await readActiveVersion(graphId);
      cache.set(graphId, schemaVersion);
    }
    return {
      op,
      recordedTo,
      schemaVersion,
      txId: context.txId,
      meta: context.meta,
    };
  }

  function requireRunMany(): NonNullable<typeof execution.runMany> {
    if (execution.runMany === undefined) {
      throw new DatabaseOperationError(
        "Atomic history capture requires a multi-statement execution seam (runMany)",
        { operation: "update", entity: "history" },
      );
    }
    return execution.runMany;
  }

  // Run a capturing statement set, returning the LAST statement's first
  // row. One statement (Postgres CTE) → execGet; two (SQLite capture +
  // mutation) → the atomic `runMany` seam (last statement has RETURNING).
  async function runCapturingGet(
    statements: readonly SQL[],
  ): Promise<Record<string, unknown> | undefined> {
    if (statements.length === 1) {
      return execution.execGet<Record<string, unknown>>(statements[0]!);
    }
    const rows = await requireRunMany()<Record<string, unknown>>(
      statements,
      true,
    );
    return rows[0];
  }

  async function runCapturingRun(statements: readonly SQL[]): Promise<void> {
    if (statements.length === 1) {
      await execution.execRun(statements[0]!);
      return;
    }
    // The last statement (a delete / soft-delete) returns no rows.
    await requireRunMany()(statements, false);
  }

  async function readNodePreImage(
    graphId: string,
    kind: string,
    id: string,
    onlyLive: boolean,
  ): Promise<NodePreImage | undefined> {
    const raw = await execution.execGet<Record<string, unknown>>(
      operationStrategy.buildGetNode(graphId, kind, id),
    );
    if (raw === undefined) return undefined;
    const row = rowMappers.toNodeRow(raw);
    if (onlyLive && row.deleted_at !== undefined) return undefined;
    return row;
  }

  async function readEdgePreImage(
    graphId: string,
    id: string,
    onlyLive: boolean,
  ): Promise<EdgePreImage | undefined> {
    const raw = await execution.execGet<Record<string, unknown>>(
      operationStrategy.buildGetEdge(graphId, id),
    );
    if (raw === undefined) return undefined;
    const row = rowMappers.toEdgeRow(raw);
    if (onlyLive && row.deleted_at !== undefined) return undefined;
    return row;
  }

  // Capture + run a node mutation that returns its row (update / restore).
  async function captureNodeReturning(
    graphId: string,
    kind: string,
    id: string,
    op: HistoryOp,
    onlyLive: boolean,
    timestamp: string,
    mutation: SQL,
  ): Promise<Record<string, unknown> | undefined> {
    const audit = await makeAudit(graphId, op, timestamp);
    if (history!.mode === "atomic") {
      const capture = history!.strategy.buildCaptureNode(graphId, kind, id, audit, {
        onlyLive,
      });
      return runCapturingGet(history!.strategy.combine(capture, mutation));
    }
    // Best-effort (non-transactional): the WRITES are mutation-first,
    // history-second (D4). Reading the pre-image first is a SELECT — it
    // persists nothing — and is unavoidable: after the mutation the
    // pre-image is gone. A crash before the mutation writes no history; a
    // crash between the mutation and the history INSERT loses a history row
    // but never writes one for a mutation that didn't land (missing, never
    // phantom). The history INSERT runs only after the mutation returned a
    // row, so it can't outlive a mutation that affected nothing.
    const preImage = await readNodePreImage(graphId, kind, id, onlyLive);
    const row = await execution.execGet<Record<string, unknown>>(mutation);
    if (row !== undefined && preImage !== undefined) {
      await execution.execRun(
        history!.strategy.buildInsertNodeHistoryFromRow(preImage, audit),
      );
    }
    return row;
  }

  async function captureEdgeReturning(
    graphId: string,
    id: string,
    op: HistoryOp,
    onlyLive: boolean,
    timestamp: string,
    mutation: SQL,
  ): Promise<Record<string, unknown> | undefined> {
    const audit = await makeAudit(graphId, op, timestamp);
    if (history!.mode === "atomic") {
      const capture = history!.strategy.buildCaptureEdge(graphId, id, audit, {
        onlyLive,
      });
      return runCapturingGet(history!.strategy.combine(capture, mutation));
    }
    const preImage = await readEdgePreImage(graphId, id, onlyLive);
    const row = await execution.execGet<Record<string, unknown>>(mutation);
    if (row !== undefined && preImage !== undefined) {
      await execution.execRun(
        history!.strategy.buildInsertEdgeHistoryFromRow(preImage, audit),
      );
    }
    return row;
  }

  // Capture + run a node soft-delete (no RETURNING).
  async function captureNodeRun(
    graphId: string,
    kind: string,
    id: string,
    timestamp: string,
    mutation: SQL,
  ): Promise<void> {
    const audit = await makeAudit(graphId, "delete", timestamp);
    if (history!.mode === "atomic") {
      const capture = history!.strategy.buildCaptureNode(graphId, kind, id, audit, {
        onlyLive: true,
      });
      await runCapturingRun(history!.strategy.combine(capture, mutation));
      return;
    }
    const preImage = await readNodePreImage(graphId, kind, id, true);
    await execution.execRun(mutation);
    if (preImage !== undefined) {
      await execution.execRun(
        history!.strategy.buildInsertNodeHistoryFromRow(preImage, audit),
      );
    }
  }

  async function captureEdgeRun(
    graphId: string,
    id: string,
    timestamp: string,
    mutation: SQL,
  ): Promise<void> {
    const audit = await makeAudit(graphId, "delete", timestamp);
    if (history!.mode === "atomic") {
      const capture = history!.strategy.buildCaptureEdge(graphId, id, audit, {
        onlyLive: true,
      });
      await runCapturingRun(history!.strategy.combine(capture, mutation));
      return;
    }
    const preImage = await readEdgePreImage(graphId, id, true);
    await execution.execRun(mutation);
    if (preImage !== undefined) {
      await execution.execRun(
        history!.strategy.buildInsertEdgeHistoryFromRow(preImage, audit),
      );
    }
  }

  return {
    async insertNode(params: InsertNodeParams): Promise<NodeRow> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertNode(params, timestamp);
      const row = await execution.execGet<Record<string, unknown>>(query);
      if (!row) throw new DatabaseOperationError("Insert node failed: no row returned", { operation: "insert", entity: "node" });
      return rowMappers.toNodeRow(row);
    },

    async insertNodeNoReturn(params: InsertNodeParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertNodeNoReturn(params, timestamp);
      await execution.execRun(query);
    },

    async insertNodesBatch(params: readonly InsertNodeParams[]): Promise<void> {
      if (params.length === 0) {
        return;
      }
      const timestamp = nowIso();
      for (const chunk of chunkArray(params, batchConfig.nodeInsertBatchSize)) {
        const query = operationStrategy.buildInsertNodesBatch(chunk, timestamp);
        await execution.execRun(query);
      }
    },

    async insertNodesBatchReturning(
      params: readonly InsertNodeParams[],
    ): Promise<readonly NodeRow[]> {
      if (params.length === 0) {
        return [];
      }
      const timestamp = nowIso();
      const allRows: NodeRow[] = [];
      for (const chunk of chunkArray(params, batchConfig.nodeInsertBatchSize)) {
        const query =
          operationStrategy.buildInsertNodesBatchReturning(chunk, timestamp);
        const rows = await execution.execAll<Record<string, unknown>>(query);
        allRows.push(...rows.map((row) => rowMappers.toNodeRow(row)));
      }
      return allRows;
    },

    async getNode(
      graphId: string,
      kind: string,
      id: string,
    ): Promise<NodeRow | undefined> {
      const query = operationStrategy.buildGetNode(graphId, kind, id);
      const row = await execution.execGet<Record<string, unknown>>(query);
      return row ? rowMappers.toNodeRow(row) : undefined;
    },

    async getNodes(
      graphId: string,
      kind: string,
      ids: readonly string[],
    ): Promise<readonly NodeRow[]> {
      if (ids.length === 0) return [];
      const allRows: NodeRow[] = [];
      for (const chunk of chunkArray(ids, batchConfig.getNodesChunkSize)) {
        const query = operationStrategy.buildGetNodes(graphId, kind, chunk);
        const rows = await execution.execAll<Record<string, unknown>>(query);
        allRows.push(...rows.map((row) => rowMappers.toNodeRow(row)));
      }
      return allRows;
    },

    async updateNode(params: UpdateNodeParams): Promise<NodeRow> {
      const timestamp = nowIso();
      const mutation = operationStrategy.buildUpdateNode(params, timestamp);
      // `clearDeleted` is the upsert-revive path → op `restore`, and its
      // mutation has no `deleted_at IS NULL` filter, so the capture must
      // not either (onlyLive = false). A plain update is op `update` and
      // only touches live rows.
      const row = await (historyActive()
        ? captureNodeReturning(
            params.graphId,
            params.kind,
            params.id,
            params.clearDeleted === true ? "restore" : "update",
            params.clearDeleted !== true,
            timestamp,
            mutation,
          )
        : execution.execGet<Record<string, unknown>>(mutation));
      if (!row) throw new DatabaseOperationError("Update node failed: no row returned", { operation: "update", entity: "node" });
      return rowMappers.toNodeRow(row);
    },

    async deleteNode(params: DeleteNodeParams): Promise<void> {
      const timestamp = nowIso();
      const mutation = operationStrategy.buildDeleteNode(params, timestamp);
      if (!historyActive()) {
        await execution.execRun(mutation);
        return;
      }
      await captureNodeRun(
        params.graphId,
        params.kind,
        params.id,
        timestamp,
        mutation,
      );
    },

    // IMPORTANT: This cascade is not atomic. Callers must ensure this runs
    // within a transaction to prevent partial deletion on intermediate failure.
    //
    // Embeddings are NOT cleaned up here: they live in per-`(nodeKind,
    // fieldPath)` strategy-owned tables addressable only with the slot
    // context the graph-agnostic backend lacks. The store's hard-delete
    // path (`executeNodeHardDelete`) drives `deleteNodeEmbeddings`, which
    // resolves each embedding field and routes a per-field
    // `backend.deleteEmbedding` through the active vector strategy.
    async hardDeleteNode(params: HardDeleteNodeParams): Promise<void> {
      const deleteUniquesQuery = operationStrategy.buildHardDeleteUniquesByNode(
        params.graphId,
        params.id,
      );
      await execution.execRun(deleteUniquesQuery);

      const deleteFulltextStatements =
        operationStrategy.buildDeleteFulltextByNode(
          params.graphId,
          params.kind,
          params.id,
        );
      for (const stmt of deleteFulltextStatements) {
        await execution.execRun(stmt);
      }

      const deleteEdgesQuery = operationStrategy.buildHardDeleteEdgesByNode(
        params.graphId,
        params.kind,
        params.id,
      );
      const deleteNodeQuery = operationStrategy.buildHardDeleteNode(params);

      if (!historyActive()) {
        await execution.execRun(deleteEdgesQuery);
        await execution.execRun(deleteNodeQuery);
        return;
      }

      // `hardDelete` preserves prior history and captures the final image
      // of every removed row — the node and each cascaded edge — so
      // hard-deleted entities stay visible to history reads. One `tx_id`
      // (one audit) groups the node + cascade. The store wraps
      // hardDeleteNode in a transaction, so each (capture, delete) pair
      // commits atomically; `combine` keeps the pair atomic at the
      // implicit-op level too.
      const timestamp = nowIso();
      const audit = await makeAudit(params.graphId, "hardDelete", timestamp);
      if (history!.mode === "atomic") {
        const captureEdges = history!.strategy.buildCaptureEdgesByNode(
          params.graphId,
          params.kind,
          params.id,
          audit,
        );
        await runCapturingRun(
          history!.strategy.combine(captureEdges, deleteEdgesQuery),
        );
        const captureNode = history!.strategy.buildCaptureNode(
          params.graphId,
          params.kind,
          params.id,
          audit,
          { onlyLive: false },
        );
        await runCapturingRun(
          history!.strategy.combine(captureNode, deleteNodeQuery),
        );
        return;
      }

      // Best-effort (non-transactional): delete first, then write history.
      // Captures the live connected edges; a tombstoned edge removed by
      // the cascade is not historized in best-effort mode (documented).
      const connectedEdgeRows = await execution.execAll<
        Record<string, unknown>
      >(
        operationStrategy.buildFindEdgesConnectedTo({
          graphId: params.graphId,
          nodeKind: params.kind,
          nodeId: params.id,
        }),
      );
      const edgePreImages = connectedEdgeRows.map((raw) =>
        rowMappers.toEdgeRow(raw),
      );
      const nodePreImage = await readNodePreImage(
        params.graphId,
        params.kind,
        params.id,
        false,
      );
      await execution.execRun(deleteEdgesQuery);
      await execution.execRun(deleteNodeQuery);
      for (const edge of edgePreImages) {
        await execution.execRun(
          history!.strategy.buildInsertEdgeHistoryFromRow(edge, audit),
        );
      }
      if (nodePreImage !== undefined) {
        await execution.execRun(
          history!.strategy.buildInsertNodeHistoryFromRow(nodePreImage, audit),
        );
      }
    },

    async insertEdge(params: InsertEdgeParams): Promise<EdgeRow> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertEdge(params, timestamp);
      const row = await execution.execGet<Record<string, unknown>>(query);
      if (!row) throw new DatabaseOperationError("Insert edge failed: no row returned", { operation: "insert", entity: "edge" });
      return rowMappers.toEdgeRow(row);
    },

    async insertEdgeNoReturn(params: InsertEdgeParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertEdgeNoReturn(params, timestamp);
      await execution.execRun(query);
    },

    async insertEdgesBatch(params: readonly InsertEdgeParams[]): Promise<void> {
      if (params.length === 0) {
        return;
      }
      const timestamp = nowIso();
      for (const chunk of chunkArray(params, batchConfig.edgeInsertBatchSize)) {
        const query = operationStrategy.buildInsertEdgesBatch(chunk, timestamp);
        await execution.execRun(query);
      }
    },

    async insertEdgesBatchReturning(
      params: readonly InsertEdgeParams[],
    ): Promise<readonly EdgeRow[]> {
      if (params.length === 0) {
        return [];
      }
      const timestamp = nowIso();
      const allRows: EdgeRow[] = [];
      for (const chunk of chunkArray(params, batchConfig.edgeInsertBatchSize)) {
        const query =
          operationStrategy.buildInsertEdgesBatchReturning(chunk, timestamp);
        const rows = await execution.execAll<Record<string, unknown>>(query);
        allRows.push(...rows.map((row) => rowMappers.toEdgeRow(row)));
      }
      return allRows;
    },

    async getEdge(graphId: string, id: string): Promise<EdgeRow | undefined> {
      const query = operationStrategy.buildGetEdge(graphId, id);
      const row = await execution.execGet<Record<string, unknown>>(query);
      return row ? rowMappers.toEdgeRow(row) : undefined;
    },

    async getEdges(
      graphId: string,
      ids: readonly string[],
    ): Promise<readonly EdgeRow[]> {
      if (ids.length === 0) return [];
      const allRows: EdgeRow[] = [];
      for (const chunk of chunkArray(ids, batchConfig.getEdgesChunkSize)) {
        const query = operationStrategy.buildGetEdges(graphId, chunk);
        const rows = await execution.execAll<Record<string, unknown>>(query);
        allRows.push(...rows.map((row) => rowMappers.toEdgeRow(row)));
      }
      return allRows;
    },

    async updateEdge(params: UpdateEdgeParams): Promise<EdgeRow> {
      const timestamp = nowIso();
      const mutation = operationStrategy.buildUpdateEdge(params, timestamp);
      const row = await (historyActive()
        ? captureEdgeReturning(
            params.graphId,
            params.id,
            params.clearDeleted === true ? "restore" : "update",
            params.clearDeleted !== true,
            timestamp,
            mutation,
          )
        : execution.execGet<Record<string, unknown>>(mutation));
      if (!row) throw new DatabaseOperationError("Update edge failed: no row returned", { operation: "update", entity: "edge" });
      return rowMappers.toEdgeRow(row);
    },

    async deleteEdge(params: DeleteEdgeParams): Promise<void> {
      const timestamp = nowIso();
      const mutation = operationStrategy.buildDeleteEdge(params, timestamp);
      if (!historyActive()) {
        await execution.execRun(mutation);
        return;
      }
      await captureEdgeRun(params.graphId, params.id, timestamp, mutation);
    },

    async hardDeleteEdge(params: HardDeleteEdgeParams): Promise<void> {
      const mutation = operationStrategy.buildHardDeleteEdge(params);
      if (!historyActive()) {
        await execution.execRun(mutation);
        return;
      }
      const timestamp = nowIso();
      const audit = await makeAudit(params.graphId, "hardDelete", timestamp);
      if (history!.mode === "atomic") {
        const capture = history!.strategy.buildCaptureEdge(
          params.graphId,
          params.id,
          audit,
          { onlyLive: false },
        );
        await runCapturingRun(history!.strategy.combine(capture, mutation));
        return;
      }
      const preImage = await readEdgePreImage(params.graphId, params.id, false);
      await execution.execRun(mutation);
      if (preImage !== undefined) {
        await execution.execRun(
          history!.strategy.buildInsertEdgeHistoryFromRow(preImage, audit),
        );
      }
    },

    async countEdgesFrom(params: CountEdgesFromParams): Promise<number> {
      const query = operationStrategy.buildCountEdgesFrom(params);
      const row = await execution.execGet<{ count: string | number }>(query);
      return Number(row?.count ?? 0);
    },

    async edgeExistsBetween(params: EdgeExistsBetweenParams): Promise<boolean> {
      const query = operationStrategy.buildEdgeExistsBetween(params);
      const row = await execution.execGet<Record<string, unknown>>(query);
      return row !== undefined;
    },

    async findEdgesConnectedTo(
      params: FindEdgesConnectedToParams,
    ): Promise<readonly EdgeRow[]> {
      const query = operationStrategy.buildFindEdgesConnectedTo(params);
      const rows = await execution.execAll<Record<string, unknown>>(query);
      return rows.map((row) => rowMappers.toEdgeRow(row));
    },

    async findNodesByKind(
      params: FindNodesByKindParams,
    ): Promise<readonly NodeRow[]> {
      const query = operationStrategy.buildFindNodesByKind(params);
      const rows = await execution.execAll<Record<string, unknown>>(query);
      return rows.map((row) => rowMappers.toNodeRow(row));
    },

    async countNodesByKind(params: CountNodesByKindParams): Promise<number> {
      const query = operationStrategy.buildCountNodesByKind(params);
      const row = await execution.execGet<{ count: string | number }>(query);
      return Number(row?.count ?? 0);
    },

    async findEdgesByKind(
      params: FindEdgesByKindParams,
    ): Promise<readonly EdgeRow[]> {
      const query = operationStrategy.buildFindEdgesByKind(params);
      const rows = await execution.execAll<Record<string, unknown>>(query);
      return rows.map((row) => rowMappers.toEdgeRow(row));
    },

    async countEdgesByKind(params: CountEdgesByKindParams): Promise<number> {
      const query = operationStrategy.buildCountEdgesByKind(params);
      const row = await execution.execGet<{ count: string | number }>(query);
      return Number(row?.count ?? 0);
    },

    async insertUnique(params: InsertUniqueParams): Promise<void> {
      const query = operationStrategy.buildInsertUnique(params);
      const result = await execution.execGet<{ node_id: string }>(query);

      if (result && result.node_id !== params.nodeId) {
        throw new UniquenessError({
          constraintName: params.constraintName,
          kind: params.nodeKind,
          existingId: result.node_id,
          newId: params.nodeId,
          fields: [],
        });
      }
    },

    async deleteUnique(params: DeleteUniqueParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildDeleteUnique(params, timestamp);
      await execution.execRun(query);
    },

    async checkUnique(
      params: CheckUniqueParams,
    ): Promise<UniqueRow | undefined> {
      const query = operationStrategy.buildCheckUnique(params);
      const row = await execution.execGet<Record<string, unknown>>(query);
      return row ? rowMappers.toUniqueRow(row) : undefined;
    },

    async checkUniqueBatch(
      params: CheckUniqueBatchParams,
    ): Promise<readonly UniqueRow[]> {
      if (params.keys.length === 0) return [];
      const allRows: UniqueRow[] = [];
      for (const chunk of chunkArray(params.keys, batchConfig.checkUniqueBatchChunkSize)) {
        const query = operationStrategy.buildCheckUniqueBatch({ ...params, keys: chunk });
        const rows = await execution.execAll<Record<string, unknown>>(query);
        allRows.push(...rows.map((row) => rowMappers.toUniqueRow(row)));
      }
      return allRows;
    },

    async getActiveSchema(
      graphId: string,
    ): Promise<SchemaVersionRow | undefined> {
      const query = operationStrategy.buildGetActiveSchema(graphId);
      const row = await execution.execGet<Record<string, unknown>>(query);
      return row ? rowMappers.toSchemaVersionRow(row) : undefined;
    },

    async getSchemaVersion(
      graphId: string,
      version: number,
    ): Promise<SchemaVersionRow | undefined> {
      const query = operationStrategy.buildGetSchemaVersion(graphId, version);
      const row = await execution.execGet<Record<string, unknown>>(query);
      return row ? rowMappers.toSchemaVersionRow(row) : undefined;
    },

    async commitSchemaVersion(
      params: CommitSchemaVersionParams,
    ): Promise<SchemaVersionRow> {
      // The top-level backend wraps this method in a transaction with
      // appropriate write-locking (BEGIN IMMEDIATE on SQLite,
      // pg_advisory_xact_lock on Postgres) so the read-then-write
      // sequence below is serialized against concurrent commits.

      const existingRaw = await execution.execGet<Record<string, unknown>>(
        operationStrategy.buildGetSchemaVersion(
          params.graphId,
          params.version,
        ),
      );
      const actualActiveVersion = await readActiveVersion(params.graphId);

      // Same-version-different-hash → content conflict. Always wins
      // over CAS: a hash disagreement is operator-intervention
      // territory regardless of which writer "got there first."
      if (existingRaw !== undefined) {
        const existing = rowMappers.toSchemaVersionRow(existingRaw);
        if (existing.schema_hash !== params.schemaHash) {
          throw new SchemaContentConflictError({
            graphId: params.graphId,
            version: params.version,
            existingHash: existing.schema_hash,
            incomingHash: params.schemaHash,
          });
        }
        // Same-version-same-hash already active → idempotent success.
        // Skips the CAS intentionally: same hash means identical
        // content, so there's no disagreement for the caller to refetch.
        if (existing.is_active) {
          return existing;
        }
        // Same-version-same-hash but inactive: orphan row left by a
        // crashed earlier commit. Reactivation requires CAS because
        // we're about to flip the active pointer — fall through.
        verifyExpectedActiveVersion(
          params.graphId,
          params.expected,
          actualActiveVersion,
        );
        const reactivate = operationStrategy.buildSetActiveSchema(
          params.graphId,
          params.version,
        );
        await execution.execRun(reactivate.deactivateAll);
        await execution.execRun(reactivate.activateVersion);
        // Project the result instead of re-SELECTing: the partial
        // unique index guarantees this is the only active row for the
        // graph after the UPDATEs above.
        return { ...existing, is_active: true };
      }

      verifyExpectedActiveVersion(
        params.graphId,
        params.expected,
        actualActiveVersion,
      );

      // Fresh insert path. For the "active" expected case, deactivate
      // the prior active row first so the partial unique index (one
      // active per graph) is satisfied at every statement boundary.
      // The "initial" case has no prior active, so skip.
      if (params.expected.kind === "active") {
        const flip = operationStrategy.buildSetActiveSchema(
          params.graphId,
          params.version,
        );
        await execution.execRun(flip.deactivateAll);
      }

      const timestamp = nowIso();
      const insertQuery = operationStrategy.buildInsertSchema(
        {
          graphId: params.graphId,
          version: params.version,
          schemaHash: params.schemaHash,
          schemaDoc: params.schemaDoc,
          isActive: true,
        },
        timestamp,
      );
      const insertedRaw =
        await execution.execGet<Record<string, unknown>>(insertQuery);
      if (!insertedRaw) {
        throw new DatabaseOperationError(
          "Insert schema failed: no row returned",
          { operation: "insert", entity: "schema" },
        );
      }
      return rowMappers.toSchemaVersionRow(insertedRaw);
    },

    async setActiveVersion(params: SetActiveVersionParams): Promise<void> {
      const actualActiveVersion = await readActiveVersion(params.graphId);
      verifyExpectedActiveVersion(
        params.graphId,
        params.expected,
        actualActiveVersion,
      );

      const targetRaw = await execution.execGet<Record<string, unknown>>(
        operationStrategy.buildGetSchemaVersion(
          params.graphId,
          params.version,
        ),
      );
      if (!targetRaw) {
        throw new MigrationError(
          `Cannot activate version ${params.version}: version does not exist for graph "${params.graphId}".`,
          {
            graphId: params.graphId,
            fromVersion: actualActiveVersion,
            toVersion: params.version,
          },
        );
      }

      const queries = operationStrategy.buildSetActiveSchema(
        params.graphId,
        params.version,
      );
      await execution.execRun(queries.deactivateAll);
      await execution.execRun(queries.activateVersion);
    },

    async clearGraph(graphId: string): Promise<void> {
      const statements = operationStrategy.buildClearGraph(graphId);
      for (const statement of statements) {
        await execution.execRun(statement);
      }
    },
  };
}
