import { statementExecutionMembers } from "../backend/capabilities/bind";
import {
  type BATCH_POINT_READ,
  type STATEMENT_EXECUTION,
} from "../backend/capabilities/bundle-registry";
import {
  batchPointReadVerdict,
  type BundleVerdictOf,
} from "../backend/capabilities/resolve";
import {
  assertCommandResultMatchesCommand,
  assertGraphCommandExecutionContext,
  executeAuthoritativeGraphCommand,
  type GraphCommandExecutionContext,
} from "../backend/command-contract";
import { deriveBackend, projectGraphBackend } from "../backend/derive-backend";
import {
  type DeleteEdgesBatchParams,
  type EdgeRow,
  type GraphBackend,
  type GraphCommand,
  type GraphCommandPort,
  type GraphCommandResult,
  type InsertEdgeParams,
  type InsertNodeParams,
  type InternalTransactionOptions,
  type NodeRow,
  type SchemaWriteFenceParams,
  type TransactionBackend,
} from "../backend/types";
import { CompilerInvariantError, ConfigurationError } from "../errors";
import { type IdentityTarget } from "../identity/sql-target";
import { type IdentityAssertionStorageRow } from "../identity/storage-types";
import { type SqlSchema } from "../query/compiler/schema";
import { sql as portableSql } from "../query/sql-fragment";
import { asCompiledStatementSql } from "../query/sql-intent";
import { groupBy } from "../utils/array";
import { requireDefined } from "../utils/presence";
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
  flushIdentityAssertions,
  flushNodes,
  queryConnectedEdgeIds,
  type TouchedEdge,
  type TouchedEntity,
  type TouchedIdentityAssertion,
  type TouchedNode,
} from "./recorded-capture/flush";
import {
  assertCapturableBackend,
  assertRecordedCaptureTransactionIsolation,
  assertRequestedRecordedIsolation,
  rawWriteGuards,
  requireCaptureStatements,
  requireRecordedSchema,
  withRecordedRelationsPrecondition,
} from "./recorded-capture/guards";

export {
  advanceRevisionClock,
  ensureRevisionOrigin,
  lockRecordedGraphWrite,
  readRecordedClock,
  readRevisionOrigin,
  recordedClockAdvisoryLockSql,
  recordedGraphWriteAdvisoryLockSql,
} from "./recorded-capture/clock";
export { closeRecordedHardDeletedKind } from "./recorded-capture/flush";
export {
  assertRecordedCaptureTransactionIsolation,
  assertRevisionTrackableBackend,
  recordedCaptureRequiresCallbackTransactionError,
  throwHistoryUnsafeSqlAccess,
  throwRevisionTrackingUnsafeSqlAccess,
  withRecordedRelationsPrecondition,
} from "./recorded-capture/guards";
export {
  RECORDED_EDGE_COLUMNS,
  RECORDED_NODE_COLUMNS,
} from "./recorded-capture/relations";
export { assertCurrentRecordedSchema } from "./recorded-capture/schema-version";
export {
  RECORDED_OPTIONAL_WRITE_METHODS,
  RECORDED_REQUIRED_WRITE_METHODS,
} from "./recorded-capture/write-surface";

type RecordedCaptureSession = Readonly<{
  /**
   * Throws if the session is sealed. Called at the TOP of every overlay write
   * method, *before* the live write runs, so a write through a context retained
   * past its `withRecordedTransaction` callback fails loud instead of committing
   * an uncaptured live row. (`touch*` also re-checks after the write; this is
   * the pre-write guard that actually prevents the live mutation.)
   */
  assertOpen: () => void;
  touchNode: (
    graphId: string,
    kind: string,
    id: string,
    afterImage?: NodeRow,
  ) => void;
  touchEdge: (graphId: string, id: string, afterImage?: EdgeRow) => void;
  touchIdentityAssertion: (
    graphId: string,
    id: string,
    afterImage?: IdentityAssertionStorageRow,
  ) => void;
  forceGraphRevision: (graphId: string) => void;
  checkpoint: () => RecordedCaptureCheckpoint;
  restore: (checkpoint: RecordedCaptureCheckpoint) => void;
  flush: (
    target: TransactionBackend,
    batchPointRead: BundleVerdictOf<typeof BATCH_POINT_READ>,
    schema: SqlSchema,
    ownsWriteLock: boolean,
  ) => Promise<RecordedFlushInstants>;
}>;

type RecordedCaptureCheckpoint = Readonly<{
  touched: ReadonlyMap<string, TouchedEntity>;
  forcedGraphRevisions: ReadonlySet<string>;
}>;

export type RecordedFlushInstants = ReadonlyMap<string, string>;

type RecordedFlushObserver = (instants: RecordedFlushInstants) => void;

const RECORDED_FLUSH_OBSERVER = Symbol("typegraph.recordedFlushObserver");

type RecordedFlushObserverOptions = InternalTransactionOptions &
  Readonly<{
    [RECORDED_FLUSH_OBSERVER]?: RecordedFlushObserver;
  }>;

function readRecordedFlushObserver(
  options: InternalTransactionOptions | undefined,
): RecordedFlushObserver | undefined {
  return (options as RecordedFlushObserverOptions | undefined)?.[
    RECORDED_FLUSH_OBSERVER
  ];
}

function stripRecordedFlushObserver(
  options: InternalTransactionOptions | undefined,
): InternalTransactionOptions | undefined {
  if (options === undefined) return undefined;
  // Omit only the observer symbol; every other (current or future)
  // TransactionOptions field passes through to the wrapped backend untouched.
  const { [RECORDED_FLUSH_OBSERVER]: _observer, ...backendOptions } =
    options as RecordedFlushObserverOptions;
  return backendOptions;
}

export function withRecordedFlushObserver(
  options: InternalTransactionOptions | undefined,
  observer: RecordedFlushObserver,
): InternalTransactionOptions {
  return {
    ...stripRecordedFlushObserver(options),
    [RECORDED_FLUSH_OBSERVER]: observer,
  } as RecordedFlushObserverOptions;
}

type RecordedTransactionScope = Readonly<{
  backend: TransactionBackend;
  flush: () => Promise<RecordedFlushInstants>;
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

function recordedCaptureSealedError(
  details: Record<string, unknown>,
): ConfigurationError {
  return new ConfigurationError(
    "Recorded-time capture session is sealed: a graph write happened after the transaction's capture was flushed.",
    details,
    {
      suggestion:
        "Perform all writes inside the withRecordedTransaction callback; do not reuse the transaction context after it returns.",
    },
  );
}

function createRecordedCaptureSession(): RecordedCaptureSession {
  const touched = new Map<string, TouchedEntity>();
  const forcedGraphRevisions = new Set<string>();
  // Sealed by flush(): a scope flushes exactly once, at its terminal point, so
  // any touch afterward means a graph write happened after capture lost its
  // flush window (e.g. a caller reused the withRecordedTransaction context after
  // it returned). Fail loud rather than let that write commit uncaptured and
  // silently diverge history from live state.
  let sealed = false;

  function touch(entity: TouchedEntity): void {
    if (sealed) {
      throw recordedCaptureSealedError({
        entity: entity.entity,
        graphId: entity.graphId,
        id: entity.id,
      });
    }
    touched.set(entityKey(entity), entity);
  }

  return {
    assertOpen(): void {
      if (sealed) throw recordedCaptureSealedError({});
    },

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

    touchIdentityAssertion(
      graphId: string,
      id: string,
      afterImage?: IdentityAssertionStorageRow,
    ): void {
      touch({ entity: "identity", graphId, id, afterImage });
    },

    forceGraphRevision(graphId: string): void {
      if (sealed) throw recordedCaptureSealedError({ graphId });
      forcedGraphRevisions.add(graphId);
    },

    checkpoint(): RecordedCaptureCheckpoint {
      if (sealed) throw recordedCaptureSealedError({});
      return {
        touched: new Map(touched),
        forcedGraphRevisions: new Set(forcedGraphRevisions),
      };
    },

    restore(checkpoint: RecordedCaptureCheckpoint): void {
      if (sealed) throw recordedCaptureSealedError({});
      touched.clear();
      for (const [key, entity] of checkpoint.touched) touched.set(key, entity);
      forcedGraphRevisions.clear();
      for (const graphId of checkpoint.forcedGraphRevisions) {
        forcedGraphRevisions.add(graphId);
      }
    },

    async flush(
      target: TransactionBackend,
      batchPointRead: BundleVerdictOf<typeof BATCH_POINT_READ>,
      schema: SqlSchema,
      ownsWriteLock: boolean,
    ): Promise<RecordedFlushInstants> {
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
      if (touched.size === 0 && forcedGraphRevisions.size === 0)
        return new Map();
      const recordedByGraph = new Map<string, string>();
      const byGraph = groupBy(touched.values(), (entity) => entity.graphId);
      for (const graphId of forcedGraphRevisions) {
        if (!byGraph.has(graphId)) byGraph.set(graphId, []);
      }
      for (const [graphId, entities] of byGraph) {
        const recordedCommit = await allocateRecordedCommit(
          target,
          schema,
          graphId,
          ownsWriteLock,
        );
        recordedByGraph.set(graphId, recordedCommit.instant);
        const nodes = entities.filter(
          (entity): entity is TouchedNode => entity.entity === "node",
        );
        const edges = entities.filter(
          (entity): entity is TouchedEdge => entity.entity === "edge",
        );
        const identityAssertions = entities.filter(
          (entity): entity is TouchedIdentityAssertion =>
            entity.entity === "identity",
        );
        await flushNodes(
          target,
          batchPointRead,
          schema,
          graphId,
          nodes,
          recordedCommit.revision,
        );
        await flushEdges(
          target,
          batchPointRead,
          schema,
          graphId,
          edges,
          recordedCommit.revision,
        );
        await flushIdentityAssertions(
          target,
          schema,
          graphId,
          identityAssertions,
          recordedCommit.revision,
        );
      }
      touched.clear();
      forcedGraphRevisions.clear();
      return recordedByGraph;
    },
  };
}

type RecordedTransactionBinding = Readonly<{
  target: TransactionBackend;
  session: RecordedCaptureSession;
  graphLocks: ReturnType<typeof createRecordedGraphLockMemo>;
}>;

type TransactionControlTarget = Readonly<
  Pick<TransactionBackend, "executeStatement">
>;

type RecordedSavepointDecision<T> =
  | Readonly<{ action: "release"; value: T }>
  | Readonly<{ action: "rollback"; value: T; cause: unknown }>;

const recordedTransactionBindings = new WeakMap<
  object,
  RecordedTransactionBinding
>();

const recordedRevisionBindings = new WeakMap<object, RecordedCaptureSession>();

/**
 * Runs one TypeGraph-owned savepoint without letting recorded state drift from
 * live state. A rollback restores both pending capture and the transaction's
 * graph-lock memo to their pre-savepoint snapshots. Callers never receive the
 * raw transaction target, so they cannot roll back SQL while forgetting the
 * TypeGraph sidecars that mirror it.
 *
 * This is deliberately the only supported savepoint seam for recorded writes.
 * Savepoints issued directly through an adopted backend remain outside the
 * capture contract because TypeGraph cannot observe their rollback boundary.
 */
export async function runRecordedTransactionSavepoint<T>(
  target: TransactionControlTarget,
  statementExecution: Extract<
    BundleVerdictOf<typeof STATEMENT_EXECUTION>,
    { supported: true }
  >,
  savepoint: string,
  fn: () => Promise<RecordedSavepointDecision<T>>,
): Promise<T> {
  const binding = recordedTransactionBindings.get(target);
  binding?.session.assertOpen();
  const rawTarget = binding?.target ?? target;
  const { executeStatement } = statementExecutionMembers(
    rawTarget,
    statementExecution,
  );
  const captureCheckpoint = binding?.session.checkpoint();
  const graphLockCheckpoint =
    binding === undefined ? undefined : new Map(binding.graphLocks);
  const restoreCapture = (): void => {
    if (
      binding === undefined ||
      captureCheckpoint === undefined ||
      graphLockCheckpoint === undefined
    )
      return;
    binding.session.restore(captureCheckpoint);
    binding.graphLocks.clear();
    for (const [graphId, lock] of graphLockCheckpoint) {
      binding.graphLocks.set(graphId, lock);
    }
  };
  const executeControl = (sql: string): Promise<unknown> =>
    executeStatement(asCompiledStatementSql(portableSql.raw(sql)));
  const rollback = async (cause: unknown): Promise<void> => {
    try {
      await executeControl(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      restoreCapture();
      await executeControl(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (recoveryError) {
      throw new AggregateError(
        [cause],
        "Failed to recover a TypeGraph recorded transaction savepoint.",
        { cause: recoveryError },
      );
    }
  };

  await executeControl(`SAVEPOINT ${savepoint}`);
  let result: RecordedSavepointDecision<T>;
  try {
    result = await fn();
  } catch (error) {
    await rollback(error);
    throw error;
  }
  if (result.action === "rollback") {
    await rollback(result.cause);
  } else {
    await executeControl(`RELEASE SAVEPOINT ${savepoint}`);
  }
  return result.value;
}

/** Forces one revision allocation when this capture transaction flushes. */
export function forceRecordedGraphRevision(
  backend: TransactionBackend,
  graphId: string,
): boolean {
  const session = recordedRevisionBindings.get(backend);
  if (session === undefined) return false;
  session.forceGraphRevision(graphId);
  return true;
}

function ignoreIdentityTouch(): void {
  return;
}

/**
 * Both sides are {@link IdentityTarget}, not the backend union: what this hands
 * `fn` is the handle identity STATEMENTS run against, and the recorded binding
 * it may swap in is a `TransactionBackend`, which satisfies that projection.
 * Typing it this way is what lets a write frame's row work — whose handle is
 * the read-only `WriteTarget` — reach the identity fold at all.
 */
export async function withRecordedIdentityMutationTarget<T>(
  target: IdentityTarget,
  fn: (
    rawTarget: IdentityTarget,
    touch: (
      graphId: string,
      id: string,
      afterImage?: IdentityAssertionStorageRow,
    ) => void,
  ) => Promise<T>,
): Promise<T> {
  const binding = recordedTransactionBindings.get(target);
  if (binding === undefined) {
    return fn(target, ignoreIdentityTouch);
  }
  binding.session.assertOpen();
  return fn(binding.target, (graphId, id, afterImage) => {
    binding.session.touchIdentityAssertion(graphId, id, afterImage);
  });
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

  const commands = {
    session: target.commands.session,
    execute: async (
      command: GraphCommand,
      context: GraphCommandExecutionContext,
    ): Promise<GraphCommandResult> => {
      session.assertOpen();
      await lockGraph(command.plan.params.graphId);
      const result = await target.commands.execute(command, context);
      assertCommandResultMatchesCommand(command, result);
      if (result.outcome === "created") {
        if (result.entity === "node") {
          session.touchNode(
            command.plan.params.graphId,
            command.plan.params.kind,
            command.plan.params.id,
            result.row,
          );
        } else {
          session.touchEdge(
            command.plan.params.graphId,
            command.plan.params.id,
            result.row,
          );
        }
      }
      return result;
    },
  } satisfies GraphCommandPort;

  const overlay = deriveBackend(target, {
    ...rawWriteGuards(target, "tx.backend"),

    async insertNode(params) {
      session.assertOpen();
      await lockGraph(params.graphId);
      const row = await target.insertNode(params);
      session.touchNode(params.graphId, params.kind, params.id, row);
      return row;
    },

    ...(target.insertNodeIfAbsent === undefined ?
      {}
    : {
        async insertNodeIfAbsent(
          params: InsertNodeParams,
        ): Promise<NodeRow | undefined> {
          session.assertOpen();
          await lockGraph(params.graphId);
          const row = await requireDefined(target.insertNodeIfAbsent)(params);
          if (row !== undefined) {
            session.touchNode(params.graphId, params.kind, params.id, row);
          }
          return row;
        },
      }),

    ...(target.insertNodeIfAbsentWithSchemaFence === undefined ?
      {}
    : {
        async insertNodeIfAbsentWithSchemaFence(
          params: InsertNodeParams,
          schemaFence: SchemaWriteFenceParams,
        ): Promise<NodeRow | undefined> {
          session.assertOpen();
          await lockGraph(params.graphId);
          const row = await requireDefined(
            target.insertNodeIfAbsentWithSchemaFence,
          )(params, schemaFence);
          if (row !== undefined) {
            session.touchNode(params.graphId, params.kind, params.id, row);
          }
          return row;
        },
      }),

    ...(target.insertNodeWithSchemaFence === undefined ?
      {}
    : {
        async insertNodeWithSchemaFence(
          params: InsertNodeParams,
          schemaFence: SchemaWriteFenceParams,
        ): Promise<NodeRow | undefined> {
          session.assertOpen();
          await lockGraph(params.graphId);
          const row = await requireDefined(target.insertNodeWithSchemaFence)(
            params,
            schemaFence,
          );
          if (row !== undefined) {
            session.touchNode(params.graphId, params.kind, params.id, row);
          }
          return row;
        },
      }),

    commands,

    ...(target.insertNodeNoReturn === undefined ?
      {}
    : {
        async insertNodeNoReturn(params: InsertNodeParams): Promise<void> {
          session.assertOpen();
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
          session.assertOpen();
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
          session.assertOpen();
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
      session.assertOpen();
      await lockGraph(params.graphId);
      const row = await target.updateNode(params);
      session.touchNode(params.graphId, params.kind, params.id, row);
      return row;
    },

    ...(target.updateNodeSet === undefined ?
      {}
    : {
        async updateNodeSet(params) {
          session.assertOpen();
          await lockGraph(params.graphId);
          const result = await requireDefined(target.updateNodeSet)(params);
          for (const row of result.rows) {
            session.touchNode(row.graph_id, row.kind, row.id, row);
          }
          return result;
        },
      }),

    ...(target.compareAndSetNode === undefined ?
      {}
    : {
        async compareAndSetNode(params) {
          session.assertOpen();
          await lockGraph(params.graphId);
          const result = await requireDefined(target.compareAndSetNode)(params);
          for (const row of result.rows) {
            session.touchNode(row.graph_id, row.kind, row.id, row);
          }
          return result;
        },
      }),

    async deleteNode(params) {
      session.assertOpen();
      await lockGraph(params.graphId);
      await target.deleteNode(params);
      session.touchNode(params.graphId, params.kind, params.id);
    },

    async hardDeleteNode(params) {
      session.assertOpen();
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
      session.assertOpen();
      await lockGraph(params.graphId);
      const row = await target.insertEdge(params);
      session.touchEdge(params.graphId, params.id, row);
      return row;
    },

    ...(target.insertEdgeNoReturn === undefined ?
      {}
    : {
        async insertEdgeNoReturn(params: InsertEdgeParams): Promise<void> {
          session.assertOpen();
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
          session.assertOpen();
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
          session.assertOpen();
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

    ...(target.insertEdgesDurableBatchReturning === undefined ?
      {}
    : {
        async insertEdgesDurableBatchReturning(
          params: readonly InsertEdgeParams[],
        ): Promise<readonly EdgeRow[]> {
          session.assertOpen();
          await lockGraphs(params);
          const rows = await requireDefined(
            target.insertEdgesDurableBatchReturning,
          )(params);
          for (const row of rows) {
            session.touchEdge(row.graph_id, row.id, row);
          }
          return rows;
        },
      }),

    async updateEdge(params) {
      session.assertOpen();
      await lockGraph(params.graphId);
      const row = await target.updateEdge(params);
      session.touchEdge(params.graphId, params.id, row);
      return row;
    },

    async deleteEdge(params) {
      session.assertOpen();
      await lockGraph(params.graphId);
      await target.deleteEdge(params);
      session.touchEdge(params.graphId, params.id);
    },

    async hardDeleteEdge(params) {
      session.assertOpen();
      await lockGraph(params.graphId);
      await target.hardDeleteEdge(params);
      session.touchEdge(params.graphId, params.id);
    },

    ...(target.deleteEdgesBatch === undefined ?
      {}
    : {
        async deleteEdgesBatch(params: DeleteEdgesBatchParams): Promise<void> {
          session.assertOpen();
          await lockGraph(params.graphId);
          await requireDefined(target.deleteEdgesBatch)(params);
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
          session.assertOpen();
          await lockGraph(params.graphId);
          await requireDefined(target.hardDeleteEdgesBatch)(params);
          for (const id of params.ids) {
            session.touchEdge(params.graphId, id);
          }
        },
      }),
  });
  registerRecordedGraphLockMemo(overlay, graphLocks);
  // Bind BOTH the overlay and the raw target to this capture session. Identity
  // mutations first resolve the overlay to its raw target (runIdentityMutation),
  // then a nested coordinator (importIdentityAssertionsIntoTarget) re-wraps that
  // RAW target — without a raw-target binding the second lookup would miss and
  // silently drop every touch, losing the merge-created assertions from history.
  recordedTransactionBindings.set(overlay, { target, session, graphLocks });
  recordedTransactionBindings.set(target, { target, session, graphLocks });
  recordedRevisionBindings.set(overlay, session);
  return overlay;
}

export function createRecordedTransactionScope(
  target: TransactionBackend,
  batchPointRead: BundleVerdictOf<typeof BATCH_POINT_READ>,
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
    async flush(): Promise<RecordedFlushInstants> {
      // By flush time the live write has committed within this transaction, so a
      // missing-table error can only be a recorded relation — surface it as the
      // typed precondition the constructor gate could not check.
      return withRecordedRelationsPrecondition(
        session.flush(target, batchPointRead, resolvedSchema, ownsWriteLock),
        { dialect: target.dialect, surface: "capture-flush" },
      );
    },
  };
}

async function runCapturedAutocommit<T>(
  backend: GraphBackend,
  schema: SqlSchema | undefined,
  batchPointRead: BundleVerdictOf<typeof BATCH_POINT_READ>,
  fn: (target: TransactionBackend) => Promise<T>,
  options?: InternalTransactionOptions,
): Promise<T> {
  assertRequestedRecordedIsolation(backend, options);
  return backend.transaction(async (target) => {
    await assertRecordedCaptureTransactionIsolation(target);
    // The bundled transaction opened BEGIN IMMEDIATE, so the write lock is held.
    const scope = createRecordedTransactionScope(
      target,
      batchPointRead,
      schema,
      true,
    );
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
  // Resolved ONCE, here, into a closure local threaded to every capture path
  // this overlay opens (ruling B8 spec item 2): the autocommit-wrapped single
  // write below and the multi-statement `transaction` override further down.
  const batchPointRead = batchPointReadVerdict(backend);
  const capture = <T>(
    fn: (target: TransactionBackend) => Promise<T>,
  ): Promise<T> => runCapturedAutocommit(backend, schema, batchPointRead, fn);

  const projectedBackend = projectGraphBackend(backend);
  return deriveBackend(projectedBackend, {
    ...rawWriteGuards(backend, "backend"),

    async insertNode(params) {
      return capture((target) => target.insertNode(params));
    },

    ...(backend.insertNodeIfAbsent === undefined ?
      {}
    : {
        async insertNodeIfAbsent(
          params: InsertNodeParams,
        ): Promise<NodeRow | undefined> {
          return capture((target) =>
            requireDefined(target.insertNodeIfAbsent)(params),
          );
        },
      }),

    ...(backend.insertNodeIfAbsentWithSchemaFence === undefined ?
      {}
    : {
        async insertNodeIfAbsentWithSchemaFence(
          params: InsertNodeParams,
          schemaFence: SchemaWriteFenceParams,
        ): Promise<NodeRow | undefined> {
          return capture((target) =>
            requireDefined(target.insertNodeIfAbsentWithSchemaFence)(
              params,
              schemaFence,
            ),
          );
        },
      }),

    ...(backend.insertNodeWithSchemaFence === undefined ?
      {}
    : {
        async insertNodeWithSchemaFence(
          params: InsertNodeParams,
          schemaFence: SchemaWriteFenceParams,
        ): Promise<NodeRow | undefined> {
          return capture((target) =>
            requireDefined(target.insertNodeWithSchemaFence)(
              params,
              schemaFence,
            ),
          );
        },
      }),

    commands: {
      session: "root",
      execute: async (
        command: GraphCommand,
        context: GraphCommandExecutionContext,
      ): Promise<GraphCommandResult> => {
        assertGraphCommandExecutionContext(context);
        if (context.session !== "root") {
          throw new CompilerInvariantError(
            "A recorded root command received a transaction execution context.",
            { contextSession: context.session },
          );
        }
        const result = await capture((target) =>
          executeAuthoritativeGraphCommand(target.commands, command),
        );
        return result;
      },
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

    ...(backend.updateNodeSet === undefined ?
      {}
    : {
        async updateNodeSet(params) {
          return capture((target) => {
            const updateNodeSet = target.updateNodeSet;
            if (updateNodeSet === undefined) {
              throw new ConfigurationError(
                "Recorded updateNodeSet capability disappeared inside a transaction",
                { operation: "updateNodeSet" },
              );
            }
            return updateNodeSet(params);
          });
        },
      }),

    ...(backend.compareAndSetNode === undefined ?
      {}
    : {
        async compareAndSetNode(params) {
          return capture((target) => {
            const compareAndSetNode = target.compareAndSetNode;
            if (compareAndSetNode === undefined) {
              throw new ConfigurationError(
                "Recorded compareAndSetNode capability disappeared inside a transaction",
                { operation: "compareAndSetNode" },
              );
            }
            return compareAndSetNode(params);
          });
        },
      }),

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

    ...(backend.insertEdgesDurableBatchReturning === undefined ?
      {}
    : {
        async insertEdgesDurableBatchReturning(
          params: readonly InsertEdgeParams[],
        ): Promise<readonly EdgeRow[]> {
          return capture((target) =>
            requireDefined(target.insertEdgesDurableBatchReturning)(params),
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
          await capture((target) =>
            requireDefined(target.deleteEdgesBatch)(params),
          );
        },
      }),

    ...(backend.hardDeleteEdgesBatch === undefined ?
      {}
    : {
        async hardDeleteEdgesBatch(
          params: DeleteEdgesBatchParams,
        ): Promise<void> {
          await capture((target) =>
            requireDefined(target.hardDeleteEdgesBatch)(params),
          );
        },
      }),

    async transaction(fn, options) {
      const observer = readRecordedFlushObserver(options);
      const backendOptions = stripRecordedFlushObserver(options);
      assertRequestedRecordedIsolation(backend, backendOptions);
      return backend.transaction(async (target) => {
        await assertRecordedCaptureTransactionIsolation(target, backendOptions);
        const readOnly = backendOptions?.accessMode === "read_only";
        const scope = createRecordedTransactionScope(
          target,
          batchPointRead,
          schema,
          !readOnly,
        );
        const result = await fn(scope.backend);
        const instants = await scope.flush();
        observer?.(instants);
        return result;
      }, backendOptions);
    },
  });
}
