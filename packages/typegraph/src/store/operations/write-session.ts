/**
 * The only sanctioned surface that mutates graph state.
 *
 * Every method is a FUSED unit — the primary row plus every sidecar that row
 * obliges — so "a new write path forgot a sidecar" stops being expressible:
 * there is no row-only primitive for a migrated module to call, because the
 * raw backend members are banned outside the step and sidecar modules the
 * session composes.
 *
 * ## Names
 *
 * Deliberately disjoint from `WRITE_MEMBER_KEYS`. The lint rule that certifies
 * this migration is `no-restricted-syntax`, which is receiver-blind: a session
 * method named `insertNode` would be flagged by the very rule that enforces
 * the seam. Renaming is chosen over a type-aware rule because the alternative
 * is a custom rule package plus type information on the lint program — real
 * infrastructure, bought only to permit a name collision we do not need.
 *
 * ## The type grows per batch, and that is load-bearing
 *
 * A method exists only once the step module it delegates to exists. B0 ships
 * the eight node methods whose delegates (`node-write-pipeline.ts`'s four
 * steps, `insert-dispatch.ts`'s four insert shapes) are already here;
 * `reviseNodeSet` arrives with `applyNodeSetUpdate`, and the edge methods with
 * `edge-write-pipeline.ts`. That schedule is what lets this module spell NO
 * banned member call at any commit — which is why it needs no lint exemption
 * on the day it lands or on any day after.
 *
 * ## Four insert shapes, not three
 *
 * `insert-dispatch.ts` exposes `one`, `oneNoReturn`, `batch` and
 * `batchReturning`, and all four are live today. `createNodes` maps to the
 * RETURNING batch; `createNodesNoReturn` maps to the no-return batch.
 * Collapsing the two would make the migrating call sites emit
 * `insertNodesBatchReturning` where they emit `insertNodesBatch` today — a
 * statement change the no-behavior-change invariant forbids.
 */
import { type z } from "zod";

import {
  type BackendIdentity,
  type FulltextOperationBackend,
  type GraphBackend,
  type GraphEntityReadBackend,
  type InsertNodeParams,
  type LiveNodeRow,
  type NodeRow,
  type QueryExecutionBackend,
  type RawQueryExecutionBackend,
  type SchemaReadBackend,
  type SqlCompilationBackend,
  type TombstonedNodeRow,
  type TransactionBackend,
  type UniqueConstraintBackend,
  type VectorOperationBackend,
} from "../../backend/types";
import { type DeleteBehavior, type UniqueConstraint } from "../../core/types";
import { type KindRegistry } from "../../registry/kind-registry";
import { type Assert, type Equal } from "../../utils/type-assert";
import {
  nodeInsertDispatch,
  runInsertBatch,
  runInsertBatchReturning,
  runInsertNoReturn,
} from "../insert-dispatch";
import { type GraphWriteLock } from "../recorded-capture/clock";
import {
  applyNodeHardDelete,
  applyNodeInsertSideEffects,
  applyNodeInsertSideEffectsBatch,
  applyNodeResurrect,
  applyNodeSoftDelete,
  applyNodeUpdate,
  createNodeWriteContext,
  type NodeDeletePolicy,
  type NodeUpdateTarget,
} from "./node-write-pipeline";
import {
  applyWriteFences,
  createWriteParamsDraft,
  NODE_UPDATE_FENCE_APPLIERS,
  type NodeUpdateFences,
} from "./write-fences";
import { type WriteMemberKey } from "./write-members";

/**
 * The backend handle row work receives: a FACET COMPOSITION of the read
 * surfaces, never `Omit<GraphBackend | TransactionBackend, …>`.
 *
 * `Omit` over a union does not distribute — `keyof (A | B)` is the
 * INTERSECTION of the key sets — so an `Omit` here would silently collapse to
 * the members both alternatives have, and every top-level-only member would
 * vanish without anyone saying so. `TransactionBackend` and
 * `TransactionReadBackend` are the existing precedents for stating the
 * composition explicitly.
 *
 * This is a TYPE-ONLY projection. At runtime the executor hands row work the
 * very object `runInWriteTransaction` gave it: a runtime projection would
 * allocate per write and would destroy the `"transaction" in target`
 * discrimination the layers above depend on.
 */
export type WriteTarget = Readonly<
  BackendIdentity &
    GraphEntityReadBackend &
    SchemaReadBackend &
    QueryExecutionBackend &
    SqlCompilationBackend &
    RawQueryExecutionBackend &
    Pick<UniqueConstraintBackend, "checkUnique" | "checkUniqueBatch"> &
    Pick<VectorOperationBackend, "vectorSearch"> &
    Pick<FulltextOperationBackend, "fulltextSearch">
>;

/**
 * THE COUNTED HOLE: widens the row-work projection back to the full backend
 * union.
 *
 * 64 signatures across `node-operations.ts`, `edge-operations.ts` and
 * `interchange/import.ts` are typed `GraphBackend | TransactionBackend`,
 * including the identity hooks. Re-typing all of them in the same batch that
 * moves the call sites would make every batch a whole-module retype, so the
 * widening is EXPLICIT, NAMED and COUNTED instead, and the ratchet drives the
 * count to zero. An `as` cast at each site would have been the same unsoundness
 * with no counter.
 */
export function unfencedTarget(
  target: WriteTarget,
): GraphBackend | TransactionBackend {
  return target as GraphBackend | TransactionBackend;
}

/** The graph-scoped state every session method's step modules need. */
export type WriteSessionContext = Readonly<{
  graphId: string;
  registry: KindRegistry;
}>;

/** The derived data a node insert obliges, alongside the row itself. */
export type NodeInsertSideEffects = Readonly<{
  kind: string;
  id: string;
  schema: z.ZodType;
  props: Record<string, unknown>;
  uniqueConstraints: readonly UniqueConstraint[];
}>;

/**
 * One node insert: the row params and the sidecar inputs, as ONE value. They
 * travel together because they are applied together; a caller cannot hand over
 * the row and keep the sidecars to itself.
 */
export type NodeInsertWork = Readonly<{
  params: InsertNodeParams;
  sideEffects: NodeInsertSideEffects;
}>;

/**
 * One node update. The validity lower-bound predicate is NOT here: it is the
 * write's fence, passed separately and required, so an update that forgot to
 * carry the bound its verdict read cannot be spelled.
 */
export type NodeUpdateWork = Readonly<{
  schema: z.ZodType;
  validatedProps: Record<string, unknown>;
  uniqueConstraints: readonly UniqueConstraint[];
  validFrom?: string | null;
  validTo?: string;
}> &
  NodeUpdateTarget;

/** One node soft delete, including the delete behavior its edges obey. */
export type NodeDeleteWork = Readonly<{
  existing: LiveNodeRow;
  schema: z.ZodType;
  uniqueConstraints: readonly UniqueConstraint[];
  onDelete: DeleteBehavior | undefined;
}>;

/** One node hard delete. */
export type NodeHardDeleteWork = Readonly<{
  kind: string;
  id: string;
  schema: z.ZodType;
  onDelete: DeleteBehavior | undefined;
}>;

/** One node resurrection: reopen a tombstone with its stored props. */
export type NodeResurrectWork = Readonly<{
  existing: TombstonedNodeRow;
  schema: z.ZodType;
  uniqueConstraints: readonly UniqueConstraint[];
}>;

export type WriteSession = Readonly<{
  // ---- B0: delegates to node-write-pipeline.ts + insert-dispatch.ts
  createNode: (work: NodeInsertWork) => Promise<NodeRow>;
  createNodeNoReturn: (work: NodeInsertWork) => Promise<void>;
  createNodes: (work: readonly NodeInsertWork[]) => Promise<readonly NodeRow[]>;
  createNodesNoReturn: (work: readonly NodeInsertWork[]) => Promise<void>;
  reviseNode: (
    work: NodeUpdateWork,
    fences: NodeUpdateFences,
  ) => Promise<NodeRow>;
  retireNode: (
    work: NodeDeleteWork,
    policy?: NodeDeletePolicy,
  ) => Promise<void>;
  purgeNode: (work: NodeHardDeleteWork) => Promise<void>;
  reviveNode: (work: NodeResurrectWork) => Promise<NodeRow>;
}>;

// No session method may collide with a banned backend member name: the lint
// rule is syntactic and receiver-blind, so a collision would make the rule
// flag the migration's own call sites.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time assertion
type _sessionNamesAreDisjointFromTheBan = Assert<
  Equal<Extract<keyof WriteSession, WriteMemberKey>, never>
>;

/**
 * Mints the session for one write frame.
 *
 * `target` is the raw transaction target the executor was handed — the same
 * object row work sees through {@link WriteTarget} — because the step modules
 * this composes take the raw union and probe optional members on it. `lock` is
 * the compile-time evidence that the per-graph write-lock discipline was
 * satisfied before any row work; the session performs no locking of its own.
 */
export function createWriteSession(
  ctx: WriteSessionContext,
  target: GraphBackend | TransactionBackend,
  lock: GraphWriteLock,
): WriteSession {
  const writeContext = createNodeWriteContext(ctx.graphId, ctx.registry, lock);
  const dispatch = nodeInsertDispatch(target);

  return {
    createNode: async (work) => {
      const row = await dispatch.one(work.params);
      await applyNodeInsertSideEffects(writeContext, work.sideEffects, target);
      return row;
    },

    createNodeNoReturn: async (work) => {
      await runInsertNoReturn(dispatch, work.params);
      await applyNodeInsertSideEffects(writeContext, work.sideEffects, target);
    },

    createNodes: async (work) => {
      const rows = await runInsertBatchReturning(
        dispatch,
        work.map((item) => item.params),
      );
      await applyNodeInsertSideEffectsBatch(
        writeContext,
        work.map((item) => item.sideEffects),
        target,
      );
      return rows;
    },

    createNodesNoReturn: async (work) => {
      await runInsertBatch(
        dispatch,
        work.map((item) => item.params),
      );
      await applyNodeInsertSideEffectsBatch(
        writeContext,
        work.map((item) => item.sideEffects),
        target,
      );
    },

    reviseNode: (work, fences) => {
      const draft = createWriteParamsDraft();
      applyWriteFences(NODE_UPDATE_FENCE_APPLIERS, fences, draft);
      return applyNodeUpdate(writeContext, { ...work, ...draft }, target);
    },

    retireNode: (work, policy) =>
      applyNodeSoftDelete(writeContext, work, target, policy),

    purgeNode: (work) => applyNodeHardDelete(writeContext, work, target),

    reviveNode: (work) => applyNodeResurrect(writeContext, work, target),
  };
}
