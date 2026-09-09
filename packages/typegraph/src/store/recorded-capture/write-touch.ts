/**
 * The one place that decides, per graph-entity write member, whether a
 * wrapped backend call actually changed a row — rather than merely having
 * been called. TypeGraph-owned recorded-time capture and the engine-native
 * mutation witness both need this exact decision (insertNodeIfAbsent's
 * `undefined` result is not a write, a `compareAndSetNode`/`updateNodeSet`
 * whose `rows` come back empty coalesced to nothing, and so on), so both
 * read it through this shared wrapper instead of re-deriving it — a second,
 * independent spelling of "did this member write" is exactly the kind of
 * drift `AGENTS.md`'s "one predicate, one owner" rule exists to prevent.
 *
 * `buildRecordedWriteMembers` covers every member in
 * `RECORDED_REQUIRED_WRITE_METHODS` ∪ `RECORDED_OPTIONAL_WRITE_METHODS`
 * (`./write-surface.ts`) except `commands`, which
 * {@link buildRecordedCommandsPort} covers separately because it is a
 * nested port rather than a plain method. `_writeTouchOverlayMatchesChecklist`
 * below pins the returned member set to that same checklist at compile
 * time, so a write surface changed in one place cannot silently narrow the
 * set both consumers wrap.
 *
 * Locking, session-liveness assertion, and image collection are consumer
 * concerns, not this module's: `hooks` lets a caller run something before
 * each write (recorded-time capture supplies `assertOpen` + the per-graph
 * advisory lock; the engine-native mutation witness supplies nothing, since
 * it neither writes a recorded relation nor needs the lock capture takes to
 * protect one), and `sink` is where the write's outcome is reported
 * (capture's sink builds history after-images; the witness's sink is a
 * single boolean flip).
 */
import { assertCommandResultMatchesCommand } from "../../backend/command-contract";
import { deriveBackend } from "../../backend/derive-backend";
import {
  type DeleteEdgesBatchParams,
  type EdgeRow,
  type GraphCommand,
  type GraphCommandExecutionContext,
  type GraphCommandPort,
  type GraphCommandResult,
  type HardDeleteNodeParams,
  type InsertEdgeParams,
  type InsertNodeParams,
  type NodeRow,
  type SchemaWriteFenceParams,
  type TransactionBackend,
} from "../../backend/types";
import { type IdentityAssertionStorageRow } from "../../identity/storage-types";
import { requireDefined } from "../../utils/presence";
import { type Assert, type Equal } from "../../utils/type-assert";
import {
  edgeInsertDispatch,
  nodeInsertDispatch,
  runInsertBatch,
  runInsertBatchReturning,
  runInsertNoReturn,
} from "../insert-dispatch";
import type {
  RECORDED_OPTIONAL_WRITE_METHODS,
  RECORDED_REQUIRED_WRITE_METHODS,
} from "./write-surface";

/**
 * Where a write member's outcome is reported. See the module doc comment.
 * `touchIdentity` is not called by anything in this module — identity
 * assertions run through `withRecordedIdentityMutationTarget`
 * (`../recorded-capture.ts`), a wholly separate seam from
 * `buildRecordedWriteMembers`'s overlay — but both consumers of this sink
 * (capture and the engine-native mutation witness) report identity touches
 * through the same object, so a caller reading "did this transaction write"
 * off one sink sees node, edge, AND identity writes rather than only two of
 * the three.
 */
export type WriteTouchSink = Readonly<{
  touchNode: (
    graphId: string,
    kind: string,
    id: string,
    afterImage?: NodeRow,
  ) => void;
  touchEdge: (graphId: string, id: string, afterImage?: EdgeRow) => void;
  touchIdentity: (
    graphId: string,
    id: string,
    afterImage?: IdentityAssertionStorageRow,
  ) => void;
}>;

/**
 * What a consumer needs to run before a write reaches the wrapped backend
 * (recorded-time capture's session-open assertion and per-graph advisory
 * lock), and how to resolve `hardDeleteNode`'s connected-edge cascade (capture
 * queries it to touch the edges a hard delete implicitly removes; the
 * mutation witness has no need of the ids themselves, only that a mutation
 * happened, so it omits this hook). Every field is optional and a no-op when
 * omitted.
 */
export type WriteMemberHooks = Readonly<{
  beforeOne?: (graphId: string) => Promise<void>;
  beforeMany?: (
    params: readonly Readonly<{ graphId: string }>[],
  ) => Promise<void>;
  connectedEdgeIdsForHardDelete?: (
    params: HardDeleteNodeParams,
  ) => Promise<readonly string[]>;
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

/** The member set {@link buildRecordedWriteMembers} returns. */
export type RecordedWriteMembersOverlay = Pick<
  TransactionBackend,
  | "insertNode"
  | "updateNode"
  | "deleteNode"
  | "hardDeleteNode"
  | "insertEdge"
  | "updateEdge"
  | "deleteEdge"
  | "hardDeleteEdge"
> &
  Partial<
    Pick<
      TransactionBackend,
      | "insertNodeIfAbsent"
      | "insertNodeIfAbsentWithSchemaFence"
      | "insertNodeWithSchemaFence"
      | "insertNodeNoReturn"
      | "insertNodesBatch"
      | "insertNodesBatchReturning"
      | "updateNodeSet"
      | "compareAndSetNode"
      | "insertEdgeNoReturn"
      | "insertEdgesBatch"
      | "insertEdgesBatchReturning"
      | "insertEdgesDurableBatchReturning"
      | "deleteEdgesBatch"
      | "hardDeleteEdgesBatch"
    >
  >;

// Pins `RecordedWriteMembersOverlay` to the write-surface checklist minus
// `commands` (covered by `buildRecordedCommandsPort`): if either side gains
// or loses a member without the other, this fails to compile rather than
// silently leaving one consumer of this wrapper short a member.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time assertion
type _writeTouchOverlayMatchesChecklist = Assert<
  Equal<
    keyof RecordedWriteMembersOverlay,
    Exclude<
      | (typeof RECORDED_REQUIRED_WRITE_METHODS)[number]
      | (typeof RECORDED_OPTIONAL_WRITE_METHODS)[number],
      "commands"
    >
  >
>;

/**
 * Builds the graph-entity write member overlay both recorded-time capture and
 * the engine-native mutation witness install on a transaction backend. See
 * the module doc comment for the division of responsibility between this
 * function, `sink`, and `hooks`.
 */
export function buildRecordedWriteMembers(
  target: TransactionBackend,
  sink: WriteTouchSink,
  hooks: WriteMemberHooks = {},
): RecordedWriteMembersOverlay {
  const nodeDispatch = nodeInsertDispatch(target);
  const edgeDispatch = edgeInsertDispatch(target);

  return {
    async insertNode(params) {
      await hooks.beforeOne?.(params.graphId);
      const row = await target.insertNode(params);
      sink.touchNode(params.graphId, params.kind, params.id, row);
      return row;
    },

    ...(target.insertNodeIfAbsent === undefined ?
      {}
    : {
        async insertNodeIfAbsent(
          params: InsertNodeParams,
        ): Promise<NodeRow | undefined> {
          await hooks.beforeOne?.(params.graphId);
          const row = await requireDefined(target.insertNodeIfAbsent)(params);
          if (row !== undefined) {
            sink.touchNode(params.graphId, params.kind, params.id, row);
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
          await hooks.beforeOne?.(params.graphId);
          const row = await requireDefined(
            target.insertNodeIfAbsentWithSchemaFence,
          )(params, schemaFence);
          if (row !== undefined) {
            sink.touchNode(params.graphId, params.kind, params.id, row);
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
          await hooks.beforeOne?.(params.graphId);
          const row = await requireDefined(target.insertNodeWithSchemaFence)(
            params,
            schemaFence,
          );
          if (row !== undefined) {
            sink.touchNode(params.graphId, params.kind, params.id, row);
          }
          return row;
        },
      }),

    ...(target.insertNodeNoReturn === undefined ?
      {}
    : {
        async insertNodeNoReturn(params: InsertNodeParams): Promise<void> {
          await hooks.beforeOne?.(params.graphId);
          await runInsertNoReturn(nodeDispatch, params);
          sink.touchNode(params.graphId, params.kind, params.id);
        },
      }),

    ...(target.insertNodesBatch === undefined ?
      {}
    : {
        async insertNodesBatch(
          params: readonly InsertNodeParams[],
        ): Promise<void> {
          await hooks.beforeMany?.(params);
          await runInsertBatch(nodeDispatch, params);
          for (const node of params) {
            sink.touchNode(node.graphId, node.kind, node.id);
          }
        },
      }),

    ...(target.insertNodesBatchReturning === undefined ?
      {}
    : {
        async insertNodesBatchReturning(
          params: readonly InsertNodeParams[],
        ): Promise<readonly NodeRow[]> {
          await hooks.beforeMany?.(params);
          const rows = await runInsertBatchReturning(nodeDispatch, params);
          const rowsByIdentity = new Map(
            rows.map((row) => [nodeRowIdentityKey(row), row] as const),
          );
          for (const node of params) {
            sink.touchNode(
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
      await hooks.beforeOne?.(params.graphId);
      const row = await target.updateNode(params);
      sink.touchNode(params.graphId, params.kind, params.id, row);
      return row;
    },

    ...(target.updateNodeSet === undefined ?
      {}
    : {
        async updateNodeSet(params) {
          await hooks.beforeOne?.(params.graphId);
          const result = await requireDefined(target.updateNodeSet)(params);
          for (const row of result.rows) {
            sink.touchNode(row.graph_id, row.kind, row.id, row);
          }
          return result;
        },
      }),

    ...(target.compareAndSetNode === undefined ?
      {}
    : {
        async compareAndSetNode(params) {
          await hooks.beforeOne?.(params.graphId);
          const result = await requireDefined(target.compareAndSetNode)(params);
          for (const row of result.rows) {
            sink.touchNode(row.graph_id, row.kind, row.id, row);
          }
          return result;
        },
      }),

    async deleteNode(params) {
      await hooks.beforeOne?.(params.graphId);
      await target.deleteNode(params);
      sink.touchNode(params.graphId, params.kind, params.id);
    },

    async hardDeleteNode(params) {
      await hooks.beforeOne?.(params.graphId);
      const connectedEdgeIds =
        (await hooks.connectedEdgeIdsForHardDelete?.(params)) ?? [];
      await target.hardDeleteNode(params);
      sink.touchNode(params.graphId, params.kind, params.id);
      for (const edgeId of connectedEdgeIds) {
        sink.touchEdge(params.graphId, edgeId);
      }
    },

    async insertEdge(params) {
      await hooks.beforeOne?.(params.graphId);
      const row = await target.insertEdge(params);
      sink.touchEdge(params.graphId, params.id, row);
      return row;
    },

    ...(target.insertEdgeNoReturn === undefined ?
      {}
    : {
        async insertEdgeNoReturn(params: InsertEdgeParams): Promise<void> {
          await hooks.beforeOne?.(params.graphId);
          await runInsertNoReturn(edgeDispatch, params);
          sink.touchEdge(params.graphId, params.id);
        },
      }),

    ...(target.insertEdgesBatch === undefined ?
      {}
    : {
        async insertEdgesBatch(
          params: readonly InsertEdgeParams[],
        ): Promise<void> {
          await hooks.beforeMany?.(params);
          await runInsertBatch(edgeDispatch, params);
          for (const edge of params) {
            sink.touchEdge(edge.graphId, edge.id);
          }
        },
      }),

    ...(target.insertEdgesBatchReturning === undefined ?
      {}
    : {
        async insertEdgesBatchReturning(
          params: readonly InsertEdgeParams[],
        ): Promise<readonly EdgeRow[]> {
          await hooks.beforeMany?.(params);
          const rows = await runInsertBatchReturning(edgeDispatch, params);
          const rowsByIdentity = new Map(
            rows.map((row) => [edgeRowIdentityKey(row), row] as const),
          );
          for (const edge of params) {
            sink.touchEdge(
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
          await hooks.beforeMany?.(params);
          const rows = await requireDefined(
            target.insertEdgesDurableBatchReturning,
          )(params);
          for (const row of rows) {
            sink.touchEdge(row.graph_id, row.id, row);
          }
          return rows;
        },
      }),

    async updateEdge(params) {
      await hooks.beforeOne?.(params.graphId);
      const row = await target.updateEdge(params);
      sink.touchEdge(params.graphId, params.id, row);
      return row;
    },

    async deleteEdge(params) {
      await hooks.beforeOne?.(params.graphId);
      await target.deleteEdge(params);
      sink.touchEdge(params.graphId, params.id);
    },

    async hardDeleteEdge(params) {
      await hooks.beforeOne?.(params.graphId);
      await target.hardDeleteEdge(params);
      sink.touchEdge(params.graphId, params.id);
    },

    ...(target.deleteEdgesBatch === undefined ?
      {}
    : {
        async deleteEdgesBatch(params: DeleteEdgesBatchParams): Promise<void> {
          await hooks.beforeOne?.(params.graphId);
          await requireDefined(target.deleteEdgesBatch)(params);
          for (const id of params.ids) {
            sink.touchEdge(params.graphId, id);
          }
        },
      }),

    ...(target.hardDeleteEdgesBatch === undefined ?
      {}
    : {
        async hardDeleteEdgesBatch(
          params: DeleteEdgesBatchParams,
        ): Promise<void> {
          await hooks.beforeOne?.(params.graphId);
          await requireDefined(target.hardDeleteEdgesBatch)(params);
          for (const id of params.ids) {
            sink.touchEdge(params.graphId, id);
          }
        },
      }),
  };
}

/**
 * Builds the `commands` port override both consumers install alongside
 * {@link buildRecordedWriteMembers} — a nested port rather than a plain
 * method, so it cannot join that function's returned object literal.
 */
export function buildRecordedCommandsPort(
  target: TransactionBackend,
  sink: WriteTouchSink,
  hooks: WriteMemberHooks = {},
): GraphCommandPort {
  return {
    session: target.commands.session,
    execute: async (
      command: GraphCommand,
      context: GraphCommandExecutionContext,
    ): Promise<GraphCommandResult> => {
      await hooks.beforeOne?.(command.plan.params.graphId);
      const result = await target.commands.execute(command, context);
      assertCommandResultMatchesCommand(command, result);
      if (result.outcome === "created") {
        if (result.entity === "node") {
          sink.touchNode(
            command.plan.params.graphId,
            command.plan.params.kind,
            command.plan.params.id,
            result.row,
          );
        } else {
          sink.touchEdge(
            command.plan.params.graphId,
            command.plan.params.id,
            result.row,
          );
        }
      }
      return result;
    },
  };
}

/**
 * An engine-native transaction's counterpart to a TypeGraph-owned capture
 * session: `wrap` installs the same write-member overlay
 * {@link buildRecordedWriteMembers} builds for capture, but its sink flips
 * one boolean instead of collecting after-images, and it takes no
 * `WriteMemberHooks` — engine-native writes no recorded relation, so there
 * is neither a session to keep open nor an advisory lock to take. `mutated`
 * answers `true` once any wrapped member has genuinely changed a row; it is
 * the source of truth an engine-native store reads before minting
 * `TransactionReceipt.recorded`, rather than a collection-level write-INTENT
 * count reaching the collection surface — a delete of a missing row, an
 * `insertNodeIfAbsent` that found the row, or a coalesced unchanged upsert
 * all reach the collection surface without a single row having changed.
 *
 * `wrap`'s overlay alone only observes the graph-entity write surface
 * {@link buildRecordedWriteMembers} covers — a real identity assertion needs
 * the returned `sink` separately registered against the SAME wrapped target
 * through `registerRecordedIdentityMutationWitness`
 * (`../recorded-capture.ts`), the identical binding seam TypeGraph-owned
 * capture registers its own session-backed sink through for
 * `withRecordedIdentityMutationTarget`. A transaction whose only effect is a
 * raw `tx.sql` statement still leaves `mutated` `false` even though the
 * engine's own revision advanced underneath it — neither this sink nor
 * identity's binding observes raw SQL, the same gap
 * `TransactionReceiptRecorder`'s old write-intent counters always had. See
 * `apps/docs/src/content/docs/queries/temporal.md`'s engine-native paragraph
 * for the same boundary stated for readers.
 *
 * `wrap` uses {@link deriveBackend}, not `deriveTransactionSessionBackend`,
 * so a source session that declared session-scoped atomic-batch authority
 * (`capabilities.execution.atomicBatch === "session"`) loses it on the
 * wrapped object. This is deliberate, not an oversight: an atomic batch
 * program executes as one opaque unit the backend runs without calling back
 * into any of the overlay's individual write members, so a write issued
 * through it would commit unobserved — silently invalidating `mutated`
 * rather than merely losing a performance optimization. Withdrawing the
 * capability keeps every write inside a receipted engine-native transaction
 * routed through a member this witness can see.
 */
export function createMutationWitness(): Readonly<{
  wrap: (target: TransactionBackend) => TransactionBackend;
  readonly mutated: boolean;
  /** The sink `wrap` installs, for `registerRecordedIdentityMutationWitness`
   * to register against the same wrapped target so an identity assertion
   * also flips `mutated`. */
  readonly sink: WriteTouchSink;
}> {
  let mutated = false;
  const sink: WriteTouchSink = {
    touchNode: () => {
      mutated = true;
    },
    touchEdge: () => {
      mutated = true;
    },
    touchIdentity: () => {
      mutated = true;
    },
  };
  return {
    wrap(target: TransactionBackend): TransactionBackend {
      return deriveBackend(target, {
        ...buildRecordedWriteMembers(target, sink),
        commands: buildRecordedCommandsPort(target, sink),
      });
    },
    get mutated(): boolean {
      return mutated;
    },
    sink,
  };
}
