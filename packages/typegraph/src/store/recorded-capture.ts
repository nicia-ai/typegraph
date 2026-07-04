import {
  createBackendOverlay,
  type DeleteEdgesBatchParams,
  type EdgeRow,
  type GraphBackend,
  type InsertEdgeParams,
  type InsertNodeParams,
  type NodeRow,
  type TransactionBackend,
  type TransactionOptions,
} from "../backend/types";
import { ConfigurationError } from "../errors";
import { type SqlSchema } from "../query/compiler/schema";
import { groupBy } from "../utils/array";
import {
  edgeInsertDispatch,
  nodeInsertDispatch,
  runInsertBatch,
  runInsertBatchReturning,
  runInsertNoReturn,
} from "./insert-dispatch";
import {
  allocateRecordedCommit,
  createRecordedGraphLockMemo,
  lockRecordedGraphWrite,
  registerRecordedGraphLockMemo,
} from "./recorded-capture/clock";
import {
  entityKey,
  flushEdges,
  flushNodes,
  queryConnectedEdgeIds,
  type TouchedEdge,
  type TouchedEntity,
  type TouchedNode,
} from "./recorded-capture/flush";
import {
  assertCapturableBackend,
  assertRecordedCaptureTransactionIsolation,
  assertRequestedRecordedIsolation,
  createHistoryUnsafeSqlRef,
  rawWriteGuards,
  recordedCaptureRequiresCallbackTransactionError,
  requireCaptureStatements,
  requireRecordedSchema,
  withRecordedRelationsPrecondition,
} from "./recorded-capture/guards";

export {
  lockRecordedGraphWrite,
  readRecordedClock,
  recordedClockAdvisoryLockSql,
  recordedGraphWriteAdvisoryLockSql,
  toCanonicalIso,
} from "./recorded-capture/clock";
export { closeRecordedHardDeletedKind } from "./recorded-capture/flush";
export {
  assertRecordedCaptureTransactionIsolation,
  createHistoryUnsafeSqlRef,
  recordedCaptureRequiresCallbackTransactionError,
  withRecordedRelationsPrecondition,
} from "./recorded-capture/guards";
export {
  RECORDED_EDGE_COLUMNS,
  RECORDED_NODE_COLUMNS,
} from "./recorded-capture/relations";
export {
  RECORDED_OPTIONAL_WRITE_METHODS,
  RECORDED_REQUIRED_WRITE_METHODS,
} from "./recorded-capture/write-surface";

type RecordedCaptureSession = Readonly<{
  touchNode: (
    graphId: string,
    kind: string,
    id: string,
    afterImage?: NodeRow,
  ) => void;
  touchEdge: (graphId: string, id: string, afterImage?: EdgeRow) => void;
  flush: (
    target: TransactionBackend,
    schema: SqlSchema,
    ownsWriteLock: boolean,
  ) => Promise<void>;
}>;

type RecordedTransactionScope = Readonly<{
  backend: TransactionBackend;
  flush: () => Promise<void>;
}>;

declare const NODE_IDENTITY_KEY_BRAND: unique symbol;
declare const EDGE_IDENTITY_KEY_BRAND: unique symbol;

type NodeIdentityKey = string &
  Readonly<{ [NODE_IDENTITY_KEY_BRAND]: "node-identity-key" }>;
type EdgeIdentityKey = string &
  Readonly<{ [EDGE_IDENTITY_KEY_BRAND]: "edge-identity-key" }>;

type NodeIdentityParams = Pick<InsertNodeParams, "graphId" | "kind" | "id">;
type NodeIdentityRow = Pick<NodeRow, "graph_id" | "kind" | "id">;
type EdgeIdentityParams = Pick<InsertEdgeParams, "graphId" | "id">;
type EdgeIdentityRow = Pick<EdgeRow, "graph_id" | "id">;

function nodeIdentityKey(
  graphId: string,
  kind: string,
  id: string,
): NodeIdentityKey {
  return `${graphId}\u0000${kind}\u0000${id}` as NodeIdentityKey;
}

function nodeParamsIdentityKey(params: NodeIdentityParams): NodeIdentityKey {
  return nodeIdentityKey(params.graphId, params.kind, params.id);
}

function nodeRowIdentityKey(row: NodeIdentityRow): NodeIdentityKey {
  return nodeIdentityKey(row.graph_id, row.kind, row.id);
}

function edgeIdentityKey(graphId: string, id: string): EdgeIdentityKey {
  return `${graphId}\u0000${id}` as EdgeIdentityKey;
}

function edgeParamsIdentityKey(params: EdgeIdentityParams): EdgeIdentityKey {
  return edgeIdentityKey(params.graphId, params.id);
}

function edgeRowIdentityKey(row: EdgeIdentityRow): EdgeIdentityKey {
  return edgeIdentityKey(row.graph_id, row.id);
}

function createRecordedCaptureSession(): RecordedCaptureSession {
  const touched = new Map<string, TouchedEntity>();
  // Sealed by flush(): a scope flushes exactly once, at its terminal point, so
  // any touch afterward means a graph write happened after capture lost its
  // flush window (e.g. a caller reused the withRecordedTransaction context after
  // it returned). Fail loud rather than let that write commit uncaptured and
  // silently diverge history from live state.
  let sealed = false;

  function touch(entity: TouchedEntity): void {
    if (sealed) {
      throw new ConfigurationError(
        "Recorded-time capture session is sealed: a graph write happened after the transaction's capture was flushed.",
        { entity: entity.entity, graphId: entity.graphId, id: entity.id },
        {
          suggestion:
            "Perform all writes inside the withRecordedTransaction callback; do not reuse the transaction context after it returns.",
        },
      );
    }
    touched.set(entityKey(entity), entity);
  }

  return {
    touchNode(
      graphId: string,
      kind: string,
      id: string,
      afterImage?: NodeRow,
    ): void {
      touch({ entity: "node", graphId, kind, id, afterImage });
    },

    touchEdge(graphId: string, id: string, afterImage?: EdgeRow): void {
      touch({ entity: "edge", graphId, id, afterImage });
    },

    async flush(
      target: TransactionBackend,
      schema: SqlSchema,
      ownsWriteLock: boolean,
    ): Promise<void> {
      if (sealed) {
        throw new ConfigurationError(
          "Recorded-time capture session was already flushed.",
          {},
          {
            suggestion:
              "A capture scope flushes once at its terminal point; do not flush it twice.",
          },
        );
      }
      // Seal before the early-return so a no-write scope is sealed too, and
      // before any awaits so a re-entrant touch during flush also fails loud.
      // flush() writes recorded rows directly (never via touch), so sealing here
      // does not block its own work.
      sealed = true;
      if (touched.size === 0) return;
      const byGraph = groupBy(touched.values(), (entity) => entity.graphId);
      for (const [graphId, entities] of byGraph) {
        const recordedCommit = await allocateRecordedCommit(
          target,
          schema,
          graphId,
          ownsWriteLock,
        );
        const nodes = entities.filter(
          (entity): entity is TouchedNode => entity.entity === "node",
        );
        const edges = entities.filter(
          (entity): entity is TouchedEdge => entity.entity === "edge",
        );
        await flushNodes(target, schema, graphId, nodes, recordedCommit);
        await flushEdges(target, schema, graphId, edges, recordedCommit);
      }
      touched.clear();
    },
  };
}

function createRecordedTransactionBackend(
  target: TransactionBackend,
  session: RecordedCaptureSession,
  schema: SqlSchema,
): TransactionBackend {
  const nodeDispatch = nodeInsertDispatch(target);
  const edgeDispatch = edgeInsertDispatch(target);

  // One advisory-lock round trip per graph per transaction: the memo is
  // shared with the returned overlay (see registerRecordedGraphLockMemo),
  // so external lock paths handed this backend dedupe against the same
  // single-flight promises — including concurrent same-transaction writers.
  const graphLocks = createRecordedGraphLockMemo();

  async function lockGraph(graphId: string): Promise<void> {
    await lockRecordedGraphWrite(target, graphId, graphLocks);
  }

  async function lockGraphs(
    params: readonly Readonly<{ graphId: string }>[],
  ): Promise<void> {
    // Codepoint sort, NOT localeCompare: every process must acquire
    // multi-graph locks in the same order, and locale-sensitive collation
    // varies with the host's ICU configuration — two processes sorting the
    // same ids differently would take the same lock pair in opposite
    // orders and deadlock.
    const graphIds = [
      ...new Set(params.map((parameter) => parameter.graphId)),
    ].toSorted();
    for (const graphId of graphIds) {
      await lockRecordedGraphWrite(target, graphId, graphLocks);
    }
  }

  const overlay = createBackendOverlay(target, {
    ...rawWriteGuards(target, "tx.backend"),

    async insertNode(params) {
      await lockGraph(params.graphId);
      const row = await target.insertNode(params);
      session.touchNode(params.graphId, params.kind, params.id, row);
      return row;
    },

    ...(target.insertNodeNoReturn === undefined ?
      {}
    : {
        async insertNodeNoReturn(params: InsertNodeParams): Promise<void> {
          await lockGraph(params.graphId);
          await runInsertNoReturn(nodeDispatch, params);
          session.touchNode(params.graphId, params.kind, params.id);
        },
      }),

    ...(target.insertNodesBatch === undefined ?
      {}
    : {
        async insertNodesBatch(
          params: readonly InsertNodeParams[],
        ): Promise<void> {
          await lockGraphs(params);
          await runInsertBatch(nodeDispatch, params);
          for (const node of params) {
            session.touchNode(node.graphId, node.kind, node.id);
          }
        },
      }),

    ...(target.insertNodesBatchReturning === undefined ?
      {}
    : {
        async insertNodesBatchReturning(
          params: readonly InsertNodeParams[],
        ): Promise<readonly NodeRow[]> {
          await lockGraphs(params);
          const rows = await runInsertBatchReturning(nodeDispatch, params);
          const rowsByIdentity = new Map(
            rows.map((row) => [nodeRowIdentityKey(row), row] as const),
          );
          for (const node of params) {
            session.touchNode(
              node.graphId,
              node.kind,
              node.id,
              rowsByIdentity.get(nodeParamsIdentityKey(node)),
            );
          }
          return rows;
        },
      }),

    async updateNode(params) {
      await lockGraph(params.graphId);
      const row = await target.updateNode(params);
      session.touchNode(params.graphId, params.kind, params.id, row);
      return row;
    },

    async deleteNode(params) {
      await lockGraph(params.graphId);
      await target.deleteNode(params);
      session.touchNode(params.graphId, params.kind, params.id);
    },

    async hardDeleteNode(params) {
      await lockGraph(params.graphId);
      const connectedEdgeIds = await queryConnectedEdgeIds(
        target,
        schema,
        params,
      );
      await target.hardDeleteNode(params);
      session.touchNode(params.graphId, params.kind, params.id);
      for (const edgeId of connectedEdgeIds) {
        session.touchEdge(params.graphId, edgeId);
      }
    },

    async insertEdge(params) {
      await lockGraph(params.graphId);
      const row = await target.insertEdge(params);
      session.touchEdge(params.graphId, params.id, row);
      return row;
    },

    ...(target.insertEdgeNoReturn === undefined ?
      {}
    : {
        async insertEdgeNoReturn(params: InsertEdgeParams): Promise<void> {
          await lockGraph(params.graphId);
          await runInsertNoReturn(edgeDispatch, params);
          session.touchEdge(params.graphId, params.id);
        },
      }),

    ...(target.insertEdgesBatch === undefined ?
      {}
    : {
        async insertEdgesBatch(
          params: readonly InsertEdgeParams[],
        ): Promise<void> {
          await lockGraphs(params);
          await runInsertBatch(edgeDispatch, params);
          for (const edge of params) {
            session.touchEdge(edge.graphId, edge.id);
          }
        },
      }),

    ...(target.insertEdgesBatchReturning === undefined ?
      {}
    : {
        async insertEdgesBatchReturning(
          params: readonly InsertEdgeParams[],
        ): Promise<readonly EdgeRow[]> {
          await lockGraphs(params);
          const rows = await runInsertBatchReturning(edgeDispatch, params);
          const rowsByIdentity = new Map(
            rows.map((row) => [edgeRowIdentityKey(row), row] as const),
          );
          for (const edge of params) {
            session.touchEdge(
              edge.graphId,
              edge.id,
              rowsByIdentity.get(edgeParamsIdentityKey(edge)),
            );
          }
          return rows;
        },
      }),

    async updateEdge(params) {
      await lockGraph(params.graphId);
      const row = await target.updateEdge(params);
      session.touchEdge(params.graphId, params.id, row);
      return row;
    },

    async deleteEdge(params) {
      await lockGraph(params.graphId);
      await target.deleteEdge(params);
      session.touchEdge(params.graphId, params.id);
    },

    async hardDeleteEdge(params) {
      await lockGraph(params.graphId);
      await target.hardDeleteEdge(params);
      session.touchEdge(params.graphId, params.id);
    },

    ...(target.deleteEdgesBatch === undefined ?
      {}
    : {
        async deleteEdgesBatch(params: DeleteEdgesBatchParams): Promise<void> {
          await lockGraph(params.graphId);
          await target.deleteEdgesBatch!(params);
          for (const id of params.ids) {
            session.touchEdge(params.graphId, id);
          }
        },
      }),

    ...(target.hardDeleteEdgesBatch === undefined ?
      {}
    : {
        async hardDeleteEdgesBatch(
          params: DeleteEdgesBatchParams,
        ): Promise<void> {
          await lockGraph(params.graphId);
          await target.hardDeleteEdgesBatch!(params);
          for (const id of params.ids) {
            session.touchEdge(params.graphId, id);
          }
        },
      }),
  });
  registerRecordedGraphLockMemo(overlay, graphLocks);
  return overlay;
}

export function createRecordedTransactionScope(
  target: TransactionBackend,
  schema?: SqlSchema,
  // True only when the enclosing transaction already holds a SQLite write lock
  // (the bundled BEGIN IMMEDIATE paths), letting clock allocation skip the
  // redundant seed-UPSERT. Defaults to false so an adopted (possibly deferred)
  // external transaction still seeds the lock — the safe choice.
  ownsWriteLock = false,
): RecordedTransactionScope {
  // Fail fast — before any write runs in the adopted/opened transaction — if
  // the transaction target cannot execute the statements capture flush needs,
  // rather than throwing mid-flush after the live write has already happened.
  requireCaptureStatements(target);
  const session = createRecordedCaptureSession();
  // Table names are fixed for the transaction's lifetime, so resolve the schema
  // once and thread it through capture instead of rebuilding it per flush. The
  // store passes its resolved schema so capture targets the same recorded
  // relations recorded reads do; the fallback covers standalone capture.
  const resolvedSchema = schema ?? requireRecordedSchema(target);
  return {
    backend: createRecordedTransactionBackend(target, session, resolvedSchema),
    async flush(): Promise<void> {
      // By flush time the live write has committed within this transaction, so a
      // missing-table error can only be a recorded relation — surface it as the
      // typed precondition the constructor gate could not check.
      await withRecordedRelationsPrecondition(
        session.flush(target, resolvedSchema, ownsWriteLock),
        { dialect: target.dialect, surface: "capture-flush" },
      );
    },
  };
}

async function runCapturedAutocommit<T>(
  backend: GraphBackend,
  schema: SqlSchema | undefined,
  fn: (target: TransactionBackend) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  assertRequestedRecordedIsolation(backend, options);
  return backend.transaction(async (target) => {
    await assertRecordedCaptureTransactionIsolation(target);
    // The bundled transaction opened BEGIN IMMEDIATE, so the write lock is held.
    const scope = createRecordedTransactionScope(target, schema, true);
    const result = await fn(scope.backend);
    await scope.flush();
    return result;
  }, options);
}

export function createRecordedBackend(
  backend: GraphBackend,
  schema?: SqlSchema,
): GraphBackend {
  assertCapturableBackend(backend);
  const capture = <T>(
    fn: (target: TransactionBackend) => Promise<T>,
  ): Promise<T> => runCapturedAutocommit(backend, schema, fn);

  return createBackendOverlay(backend, {
    ...rawWriteGuards(backend, "backend"),

    async insertNode(params) {
      return capture((target) => target.insertNode(params));
    },

    ...(backend.insertNodeNoReturn === undefined ?
      {}
    : {
        async insertNodeNoReturn(params: InsertNodeParams): Promise<void> {
          await capture((target) =>
            runInsertNoReturn(nodeInsertDispatch(target), params),
          );
        },
      }),

    ...(backend.insertNodesBatch === undefined ?
      {}
    : {
        async insertNodesBatch(
          params: readonly InsertNodeParams[],
        ): Promise<void> {
          await capture((target) =>
            runInsertBatch(nodeInsertDispatch(target), params),
          );
        },
      }),

    ...(backend.insertNodesBatchReturning === undefined ?
      {}
    : {
        async insertNodesBatchReturning(
          params: readonly InsertNodeParams[],
        ): Promise<readonly NodeRow[]> {
          return capture((target) =>
            runInsertBatchReturning(nodeInsertDispatch(target), params),
          );
        },
      }),

    async updateNode(params) {
      return capture((target) => target.updateNode(params));
    },

    async deleteNode(params) {
      await capture((target) => target.deleteNode(params));
    },

    async hardDeleteNode(params) {
      await capture((target) => target.hardDeleteNode(params));
    },

    async insertEdge(params) {
      return capture((target) => target.insertEdge(params));
    },

    ...(backend.insertEdgeNoReturn === undefined ?
      {}
    : {
        async insertEdgeNoReturn(params: InsertEdgeParams): Promise<void> {
          await capture((target) =>
            runInsertNoReturn(edgeInsertDispatch(target), params),
          );
        },
      }),

    ...(backend.insertEdgesBatch === undefined ?
      {}
    : {
        async insertEdgesBatch(
          params: readonly InsertEdgeParams[],
        ): Promise<void> {
          await capture((target) =>
            runInsertBatch(edgeInsertDispatch(target), params),
          );
        },
      }),

    ...(backend.insertEdgesBatchReturning === undefined ?
      {}
    : {
        async insertEdgesBatchReturning(
          params: readonly InsertEdgeParams[],
        ): Promise<readonly EdgeRow[]> {
          return capture((target) =>
            runInsertBatchReturning(edgeInsertDispatch(target), params),
          );
        },
      }),

    async updateEdge(params) {
      return capture((target) => target.updateEdge(params));
    },

    async deleteEdge(params) {
      await capture((target) => target.deleteEdge(params));
    },

    async hardDeleteEdge(params) {
      await capture((target) => target.hardDeleteEdge(params));
    },

    ...(backend.deleteEdgesBatch === undefined ?
      {}
    : {
        async deleteEdgesBatch(params: DeleteEdgesBatchParams): Promise<void> {
          await capture((target) => target.deleteEdgesBatch!(params));
        },
      }),

    ...(backend.hardDeleteEdgesBatch === undefined ?
      {}
    : {
        async hardDeleteEdgesBatch(
          params: DeleteEdgesBatchParams,
        ): Promise<void> {
          await capture((target) => target.hardDeleteEdgesBatch!(params));
        },
      }),

    async transaction(fn, options) {
      assertRequestedRecordedIsolation(backend, options);
      return backend.transaction(async (target) => {
        await assertRecordedCaptureTransactionIsolation(target);
        // Bundled BEGIN IMMEDIATE transaction — the write lock is already held.
        const scope = createRecordedTransactionScope(target, schema, true);
        const result = await fn(scope.backend, createHistoryUnsafeSqlRef());
        await scope.flush();
        return result;
      }, options);
    },

    ...(backend.adoptTransaction === undefined ?
      {}
    : {
        adoptTransaction(externalTx): TransactionBackend {
          throw recordedCaptureRequiresCallbackTransactionError({
            externalTxType: typeof externalTx,
          });
        },
      }),
  });
}
