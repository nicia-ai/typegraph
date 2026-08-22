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
 * A method exists only once the step module it delegates to exists. B0 shipped
 * the eight node methods whose delegates (`node-write-pipeline.ts`'s four
 * steps, `insert-dispatch.ts`'s four insert shapes) were already here; B1b
 * added `reviseNodeSet` in the same commit as `applyNodeSetUpdate`, and B2
 * added the seven edge methods in the same commit as `edge-write-pipeline.ts`.
 * That schedule is what lets this module spell NO banned member call at any
 * commit — which is why it needs no lint exemption on the day it lands or on
 * any day after.
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

import { type UNIQUE_SIDECAR_BATCH } from "../../backend/capabilities/bundle-registry";
import {
  type BundleVerdictOf,
  type ClaimsVerdictThunk,
} from "../../backend/capabilities/resolve";
import {
  type BackendIdentity,
  type ClaimEdgeCardinalityParams,
  type EdgeRow,
  type FulltextOperationBackend,
  type GraphBackend,
  type GraphEntityReadBackend,
  type InsertEdgeParams,
  type InsertNodeParams,
  type LiveNodeRow,
  type NodeRow,
  type QueryExecutionBackend,
  type RawQueryExecutionBackend,
  type RawStatementExecutionBackend,
  type SchemaReadBackend,
  type SchemaWriteFenceParams,
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
  claimEdgeCardinality,
  claimEdgeCardinalityBatch,
} from "../claims/edge-claims";
import {
  type NodeClaimItem,
  withNodeCreateClaims,
  withNodeCreateClaimsBatch,
} from "../claims/node-claims";
import {
  edgeInsertDispatch,
  nodeInsertDispatch,
  runInsertBatch,
  runInsertBatchReturning,
  runInsertIfAbsent,
  runInsertNoReturn,
} from "../insert-dispatch";
import { type GraphWriteLock } from "../recorded-capture/clock";
import {
  applyEdgeHardDelete,
  applyEdgeSoftDelete,
  applyEdgeUpdate,
  createEdgeWriteContext,
  type EdgeDeleteWork,
  type EdgeHardDeleteWork,
  type EdgeUpdateWork,
} from "./edge-write-pipeline";
import {
  applyNodeHardDelete,
  applyNodeInsertSyncFans,
  applyNodeInsertSyncFansBatch,
  applyNodeResurrect,
  applyNodeSetUpdate,
  applyNodeSoftDelete,
  applyNodeUpdate,
  createNodeWriteContext,
  type NodeDeletePolicy,
  type NodeSetUpdateResult,
  type NodeSetUpdateWork,
  type NodeUpdateTarget,
} from "./node-write-pipeline";
import {
  applyWriteFences,
  createWriteParamsDraft,
  EDGE_UPDATE_FENCE_APPLIERS,
  type EdgeUpdateFences,
  NODE_SET_UPDATE_FENCE_APPLIERS,
  NODE_UPDATE_FENCE_APPLIERS,
  type NodeSetUpdateFences,
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
    RawStatementExecutionBackend &
    Pick<
      GraphBackend,
      | "insertNodeIfAbsent"
      | "insertNodeIfAbsentWithSchemaFence"
      | "insertNodeWithSchemaFence"
    > &
    Pick<UniqueConstraintBackend, "checkUnique" | "checkUniqueBatch"> &
    Pick<
      GraphBackend,
      | "insertEdgeIfEndpointsLive"
      | "insertEdgeIfEndpointsLiveWithSchemaFence"
      | "claimEdgeCardinality"
      | "claimEdgeCardinalityGuarded"
      | "claimEdgeCardinalityBatch"
      | "purgeEdgeClaims"
      | "hardDeleteUniquesByConcreteKind"
    > &
    Pick<VectorOperationBackend, "vectorSearch"> &
    Pick<FulltextOperationBackend, "fulltextSearch">
>;

/**
 * THE COUNTED HOLE: widens the row-work projection back to the full backend
 * union.
 *
 * It existed because the migration moved call sites one module at a time while
 * their preparation helpers, constraint probes, uniqueness probes and identity
 * hooks were still typed `GraphBackend | TransactionBackend`; re-typing all of
 * those in the same batch that moved the call sites would have made every batch
 * a whole-module retype. So the widening was EXPLICIT, NAMED and COUNTED, and
 * the ratchet drove the count down as those signatures were re-typed. An `as`
 * cast at each site would have been the same unsoundness with no counter.
 *
 * **Exactly one caller remains, and it is structural, not debt.**
 * `executeEdgeBulkGetOrCreateByEndpoints` runs nested managed writes inside its
 * own frame: each nested leg re-enters the executor against THIS transaction
 * target, and re-entry needs the full union by construction — it mints a
 * session, which writes. Inlining those legs' row work would drop the nested
 * frames' schema fence and revision-clock advance, i.e. change behavior. The
 * ratchet therefore records ONE as a reasoned floor, the same way it records
 * two permanently allowlisted managed-write entry points, rather than pretending
 * a zero it would have to buy with a statement change.
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
  /**
   * The `claims` bundle's memoized, at-most-once verdict thunk (ruling B7
   * refinement 2). Called at the site that needs it — never hoisted into
   * store construction, which would resolve it eagerly and break a
   * contradictory-declaration backend's ability to construct a store at all.
   */
  claimsVerdict: ClaimsVerdictThunk;
  /**
   * The `uniqueSidecarBatch` bundle's verdict (ruling B8 spec item 2),
   * resolved once at store construction (or once per import call) and
   * threaded here for `createNodeWriteContext` — never re-resolved.
   */
  uniqueSidecarBatch: BundleVerdictOf<typeof UNIQUE_SIDECAR_BATCH>;
}>;

/** The derived data a node insert obliges, alongside the row itself. */
type NodeInsertSideEffects = Readonly<{
  kind: string;
  id: string;
  schema: z.ZodType;
  props: Record<string, unknown>;
  uniqueConstraints: readonly UniqueConstraint[];
}>;

/**
 * One node insert: the row params, the claims the row owes, and the sidecar
 * inputs, as ONE value. They travel together because they are applied together;
 * a caller cannot hand over the row and keep either half to itself.
 *
 * The claim item is the DECLARATION the claim seam reads its entries from — not
 * the entries themselves — because the seam owns both "what claims does this row
 * owe" and "when is each due", and a caller that could hand over a prepared
 * entry list could hand over a shorter one.
 */
export type NodeInsertWork = Readonly<{
  params: InsertNodeParams;
  claim: NodeClaimItem;
  sideEffects: NodeInsertSideEffects;
}>;

/**
 * One node update. The validity lower-bound predicate is NOT here: it is the
 * write's fence, passed separately and required, so an update that forgot to
 * carry the bound its verdict read cannot be spelled.
 */
type NodeUpdateWork = Readonly<{
  schema: z.ZodType;
  validatedProps: Record<string, unknown>;
  uniqueConstraints: readonly UniqueConstraint[];
  validFrom?: string | null;
  /**
   * The window end this update states, and the flag that clears one. Declared as
   * two independent optionals rather than as `BackendValidityEndMutation`'s
   * discriminated pair, because `applyNodeUpdate` — not this record — is what
   * resolves them into the mutually exclusive params, and the store's callers
   * build them with conditional spreads a union cannot narrow.
   */
  validTo?: string;
  clearValidTo?: true;
}> &
  NodeUpdateTarget;

/** One node soft delete, including the delete behavior its edges obey. */
type NodeDeleteWork = Readonly<{
  existing: LiveNodeRow;
  schema: z.ZodType;
  uniqueConstraints: readonly UniqueConstraint[];
  onDelete: DeleteBehavior | undefined;
}>;

/** One node hard delete. */
type NodeHardDeleteWork = Readonly<{
  kind: string;
  id: string;
  schema: z.ZodType;
  onDelete: DeleteBehavior | undefined;
}>;

/** One node resurrection: reopen a tombstone with its stored props. */
type NodeResurrectWork = Readonly<{
  existing: TombstonedNodeRow;
  schema: z.ZodType;
  uniqueConstraints: readonly UniqueConstraint[];
}>;

/**
 * One edge insert: the row params and the cardinality claim the row owes.
 *
 * An edge write obliges no DERIVED data — no uniqueness entries, no fulltext, no
 * embeddings — but a constrained kind owes a claim, and the claim is what fences
 * the axis its declaration spans. It is absent for an unconstrained kind and for
 * a born-ended row whose cardinality does not count it, which is what
 * `edgeCardinalityClaim` decides; the caller states the decision and this
 * surface applies it at its PRE-INSERT placement.
 *
 * The update and delete work records live in `edge-write-pipeline.ts` instead,
 * beside the steps that consume them; these four methods have no step module of
 * their own (they delegate to `insert-dispatch.ts`), so their work record lives
 * here with them.
 */
export type EdgeInsertWork = Readonly<{
  params: InsertEdgeParams;
  claim?: ClaimEdgeCardinalityParams;
}>;

/** The claims a batch of edge inserts owes, in the order the batch writer sorts. */
function edgeBatchClaims(
  work: readonly EdgeInsertWork[],
): readonly ClaimEdgeCardinalityParams[] {
  return work.flatMap((item) => (item.claim === undefined ? [] : [item.claim]));
}

export type NodeWriteSession = Readonly<{
  // ---- B0: delegates to node-write-pipeline.ts + insert-dispatch.ts
  createNode: (work: NodeInsertWork) => Promise<NodeRow>;
  /** A conflict-safe insert for a no-claim create; undefined means occupied. */
  createNodeIfAbsent: (work: NodeInsertWork) => Promise<NodeRow | undefined>;
  createNodeIfAbsentWithSchemaFence: (
    work: NodeInsertWork,
    schemaFence: SchemaWriteFenceParams,
  ) => Promise<NodeRow | undefined>;
  createNodeWithSchemaFence: (
    work: NodeInsertWork,
    schemaFence: SchemaWriteFenceParams,
  ) => Promise<NodeRow | undefined>;
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

  // ---- B1b: delegates to node-write-pipeline.ts's applyNodeSetUpdate
  reviseNodeSet: (
    work: NodeSetUpdateWork,
    fences: NodeSetUpdateFences,
  ) => Promise<NodeSetUpdateResult>;
}>;

export type EdgeWriteSession = Readonly<{
  // ---- B2: delegates to edge-write-pipeline.ts + insert-dispatch.ts
  createEdge: (work: EdgeInsertWork) => Promise<EdgeRow>;
  createEdgeIfEndpointsLive: (
    work: EdgeInsertWork,
  ) => Promise<EdgeRow | undefined>;
  createEdgeIfEndpointsLiveWithSchemaFence: (
    params: InsertEdgeParams,
    schemaFence: SchemaWriteFenceParams,
  ) => Promise<EdgeRow | undefined>;
  createEdgeNoReturn: (work: EdgeInsertWork) => Promise<void>;
  createEdges: (work: readonly EdgeInsertWork[]) => Promise<readonly EdgeRow[]>;
  createEdgesNoReturn: (work: readonly EdgeInsertWork[]) => Promise<void>;
  reviseEdge: (
    work: EdgeUpdateWork,
    fences: EdgeUpdateFences,
  ) => Promise<EdgeRow>;
  retireEdge: (work: EdgeDeleteWork) => Promise<void>;
  purgeEdge: (work: EdgeHardDeleteWork) => Promise<void>;
}>;

export type WriteSession = NodeWriteSession & EdgeWriteSession;

export type WriteSessionFor<K extends "node" | "edge" | "mixed"> =
  K extends "node" ? NodeWriteSession
  : K extends "edge" ? EdgeWriteSession
  : WriteSession;

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
  const writeContext = createNodeWriteContext(
    ctx.graphId,
    ctx.registry,
    lock,
    ctx.claimsVerdict,
    ctx.uniqueSidecarBatch,
  );
  const dispatch = nodeInsertDispatch(target);
  const edgeContext = createEdgeWriteContext(
    ctx.graphId,
    lock,
    ctx.claimsVerdict,
  );
  const edgeDispatch = edgeInsertDispatch(target);

  return {
    // The pinned coordination order, spelled once per insert shape:
    // pre-insert claims, the row, post-insert claims, the sync fans. The claim
    // seam owns the two groups and the compensation between them; this surface
    // owns only "the row write it gates is THIS one".
    createNode: async (work) => {
      const row = await withNodeCreateClaims(
        writeContext,
        work.claim,
        target,
        () => dispatch.one(work.params),
      );
      await applyNodeInsertSyncFans(writeContext, work.sideEffects, target);
      return row;
    },

    createNodeIfAbsent: async (work) => {
      const row = await runInsertIfAbsent(dispatch, work.params);
      if (row === undefined) return;
      await applyNodeInsertSyncFans(writeContext, work.sideEffects, target);
      return row;
    },

    createNodeIfAbsentWithSchemaFence: async (work, schemaFence) => {
      const insert = target.insertNodeIfAbsentWithSchemaFence;
      if (insert === undefined) return;
      const row = await insert(work.params, schemaFence);
      if (row === undefined) return;
      await applyNodeInsertSyncFans(writeContext, work.sideEffects, target);
      return row;
    },

    createNodeWithSchemaFence: async (work, schemaFence) => {
      const insert = target.insertNodeWithSchemaFence;
      if (insert === undefined) return;
      const row = await insert(work.params, schemaFence);
      if (row === undefined) return;
      await applyNodeInsertSyncFans(writeContext, work.sideEffects, target);
      return row;
    },

    createNodeNoReturn: async (work) => {
      await withNodeCreateClaims(writeContext, work.claim, target, () =>
        runInsertNoReturn(dispatch, work.params),
      );
      await applyNodeInsertSyncFans(writeContext, work.sideEffects, target);
    },

    createNodes: async (work) => {
      const rows = await withNodeCreateClaimsBatch(
        writeContext,
        work.map((item) => item.claim),
        target,
        () =>
          runInsertBatchReturning(
            dispatch,
            work.map((item) => item.params),
          ),
      );
      await applyNodeInsertSyncFansBatch(
        writeContext,
        work.map((item) => item.sideEffects),
        target,
      );
      return rows;
    },

    createNodesNoReturn: async (work) => {
      await withNodeCreateClaimsBatch(
        writeContext,
        work.map((item) => item.claim),
        target,
        () =>
          runInsertBatch(
            dispatch,
            work.map((item) => item.params),
          ),
      );
      await applyNodeInsertSyncFansBatch(
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

    reviseNodeSet: (work, fences) => {
      // The fences are applied for their REFUSAL, not for their contribution:
      // this kind's one applier throws for a stated bound and writes nothing
      // for an empty one, so a draft that survives the call is provably empty
      // and there is no predicate to thread into the statement. Skipping the
      // call would be this layer re-deciding what the applier decides.
      applyWriteFences(
        NODE_SET_UPDATE_FENCE_APPLIERS,
        fences,
        createWriteParamsDraft(),
      );
      return applyNodeSetUpdate(writeContext, work, target);
    },

    // An edge write obliges no DERIVED data, so these apply no sync fans — but a
    // constrained kind owes its cardinality claim, at the same PRE-INSERT
    // placement a node's scope-spanning claim takes and for the same reason: the
    // probe that authorised the insert read a population no key fences. The
    // batch issues ONE sorted statement (`claimEdgeCardinalityBatch` orders by
    // `compareClaimTargets`), so a batch and a peer batch take their row locks
    // in the same order.
    createEdge: async (work) => {
      if (work.claim !== undefined) {
        await claimEdgeCardinality(target, ctx.claimsVerdict(), work.claim);
      }
      return edgeDispatch.one(work.params);
    },

    createEdgeIfEndpointsLive: async (work) => {
      if (work.claim !== undefined) {
        await claimEdgeCardinality(target, ctx.claimsVerdict(), work.claim);
      }
      const insertEdgeIfEndpointsLive = target.insertEdgeIfEndpointsLive;
      if (insertEdgeIfEndpointsLive === undefined) {
        return;
      }
      return insertEdgeIfEndpointsLive(work.params);
    },

    createEdgeIfEndpointsLiveWithSchemaFence: (params, schemaFence) => {
      const insert = target.insertEdgeIfEndpointsLiveWithSchemaFence;
      if (insert === undefined) return Promise.resolve(undefined);
      return insert(params, schemaFence);
    },

    createEdgeNoReturn: async (work) => {
      if (work.claim !== undefined) {
        await claimEdgeCardinality(target, ctx.claimsVerdict(), work.claim);
      }
      await runInsertNoReturn(edgeDispatch, work.params);
    },

    createEdges: async (work) => {
      await claimEdgeCardinalityBatch(
        target,
        ctx.claimsVerdict(),
        edgeBatchClaims(work),
      );
      return runInsertBatchReturning(
        edgeDispatch,
        work.map((item) => item.params),
      );
    },

    createEdgesNoReturn: async (work) => {
      await claimEdgeCardinalityBatch(
        target,
        ctx.claimsVerdict(),
        edgeBatchClaims(work),
      );
      await runInsertBatch(
        edgeDispatch,
        work.map((item) => item.params),
      );
    },

    reviseEdge: (work, fences) => {
      const draft = createWriteParamsDraft();
      applyWriteFences(EDGE_UPDATE_FENCE_APPLIERS, fences, draft);
      return applyEdgeUpdate(edgeContext, { ...work, ...draft }, target);
    },

    retireEdge: (work) => applyEdgeSoftDelete(edgeContext, work, target),

    purgeEdge: (work) => applyEdgeHardDelete(edgeContext, work, target),
  };
}
