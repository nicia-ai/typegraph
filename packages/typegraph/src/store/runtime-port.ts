import { type UNIQUE_SIDECAR_BATCH } from "../backend/capabilities/bundle-registry";
import { type BundleVerdictOf } from "../backend/capabilities/resolve";
import {
  type BackendIdentity,
  type GraphBackend,
  type GraphEntityReadBackend,
  type QueryExecutionBackend,
  type RawQueryExecutionBackend,
  type SchemaReadBackend,
  type SqlCompilationBackend,
  type TransactionBackend,
} from "../backend/types";
import {
  type AllNodeTypes,
  type EdgeKinds,
  type GraphDef,
  type NodeKinds,
} from "../core/define-graph";
import { type ReadCoordinate } from "../core/temporal";
import {
  type AnyEdgeType,
  type EdgeId,
  type NodeId,
  type NodeType,
} from "../core/types";
import { type IdentityServiceContext } from "../identity/service-types";
import {
  type IdentityDecisionProvenance,
  type IdentityTransitionCursor,
  type IdentityTransitionTransfer,
} from "../identity/transition-log";
import { type IdentityReadFacade } from "../identity/types";
import { type InitialQueryBuilder } from "../query/builder";
import { typeGraphGlobalSymbol } from "../utils/global-symbol";
import { requireDefined } from "../utils/presence";
import { type InternalGraphAlgorithms } from "./algorithms";
import { type NodeDeletePolicy } from "./operations/node-write-pipeline";
import {
  type InternalSubgraphOptions,
  type SubgraphProjectFor,
  type SubgraphResult,
  type SubgraphResultEdgeKinds,
} from "./subgraph";
import {
  type Edge,
  type Node,
  type RecordedScanOptions,
  type RecordedScanPage,
  TRANSACTION_RUNTIME,
} from "./types";

export const STORE_RUNTIME: unique symbol =
  typeGraphGlobalSymbol("store-runtime-v1");

/**
 * @internal Operations used by Store-owned views. The port is absent from the
 * public Store contract and non-enumerable at runtime. JavaScript reflection
 * can still discover symbol properties, so this is an unsupported internal
 * surface rather than a security boundary.
 */
export type StoreRuntime<G extends GraphDef> = Readonly<{
  backend: GraphBackend;
  /**
   * @internal Whether TypeGraph itself performs recorded-time capture for
   * this store — recorded relations, a TypeGraph clock, the write-fence/
   * schema-lock machinery capture needs. This is `Store`'s private
   * `#captureEnabled`, distinct from the public `historyEnabled` getter
   * (which answers "was `history: true` requested," true under
   * engine-native ownership too, where the engine tracks history on its
   * own and none of the TypeGraph-relations machinery below runs). A reader
   * of a recorded relation's own columns — `recordedRelationsLineage`, the
   * trusted-import bypass refusal, a revision-anchor lineage delta, the
   * capture-only merge-transaction isolation choice — consults this member,
   * never the public getter, so it cannot be fooled by an engine-native
   * store into reading a recorded relation the engine never populates.
   *
   * Optional at this boundary for the same contravariant-reach reason as
   * `uniqueSidecarBatch` below: the one real producer (`store.ts`'s
   * constructor) always populates it, and a consumer asserts it with
   * {@link storeCaptureEnabled}.
   */
  captureEnabled?: boolean;
  /**
   * @internal The `uniqueSidecarBatch` bundle's verdict, resolved once at
   * store construction against `backend` (ruling B8 spec item 2) and exposed
   * here so a Store-owned view (provenance's fact close/reopen) can build a
   * {@link file://./claims/node-claims.ts NodeClaimContext} without re-minting
   * a second verdict for the same backend — the same reason `backend` itself
   * is exposed here rather than reconstructed.
   *
   * Optional at this boundary, required after resolution — the same pattern
   * `CompileQueryOptions.recursiveTraversal` uses: the one real producer
   * (`store.ts`'s constructor) always populates it, and the one real
   * consumer (`provenance/index.ts`) asserts it with `requireDefined`. This
   * shim predates the ruling that `StoreRuntime` is an `@internal`,
   * symbol-keyed port no external consumer can name; later members are added
   * as plain required members, and the API-surface checker's findings for
   * them are recorded in `etc/api-surface-exceptions.json` rather than
   * shimmed. Kept as is so its consumer's assertion stays truthful.
   */
  uniqueSidecarBatch?: BundleVerdictOf<typeof UNIQUE_SIDECAR_BATCH> | undefined;
  /**
   * @internal The backend this Store's queries actually execute through for
   * `target` — the Store's own backend when `target` is omitted.
   *
   * It is the SAME private construction the query path uses rather than a
   * reconstruction of it, because the object it returns is the one a lost
   * derivation corrupts: the hooked query backend is a transient local inside
   * query construction that is stored nowhere, so no other handle on it exists
   * and a regression there is invisible to every assertion about
   * {@link StoreRuntime.backend}.
   *
   * NOTE for anything asserting on it: with no query hook configured this
   * returns its argument unchanged, so a hookless Store answers with the very
   * object it was handed and a comparison against that object is a tautology.
   */
  queryBackend: (target?: GraphBackend | TransactionBackend) => GraphBackend;
  sealedQuery: (coordinate: ReadCoordinate) => InitialQueryBuilder<G, "sealed">;
  recordedNodeGetById: <N extends NodeType>(
    kind: string,
    id: NodeId<N>,
    coordinate: ReadCoordinate,
  ) => Promise<Node<N> | undefined>;
  recordedNodeGetByIds: <N extends NodeType>(
    kind: string,
    ids: readonly NodeId<N>[],
    coordinate: ReadCoordinate,
  ) => Promise<readonly (Node<N> | undefined)[]>;
  recordedNodeScan: <N extends NodeType>(
    kind: string,
    coordinate: ReadCoordinate,
    options?: RecordedScanOptions,
  ) => Promise<RecordedScanPage<Node<N>>>;
  recordedEdgeGetById: <E extends AnyEdgeType>(
    kind: string,
    id: EdgeId<E>,
    coordinate: ReadCoordinate,
  ) => Promise<Edge<E> | undefined>;
  recordedEdgeGetByIds: <E extends AnyEdgeType>(
    kind: string,
    ids: readonly EdgeId<E>[],
    coordinate: ReadCoordinate,
  ) => Promise<readonly (Edge<E> | undefined)[]>;
  recordedEdgeScan: <E extends AnyEdgeType>(
    kind: string,
    coordinate: ReadCoordinate,
    options?: RecordedScanOptions,
  ) => Promise<RecordedScanPage<Edge<E>>>;
  subgraphAtCoordinate: <
    const EK extends EdgeKinds<G>,
    const NK extends NodeKinds<G> = NodeKinds<G>,
    const P extends SubgraphProjectFor<G, NK, EK, C> | undefined = undefined,
    const C extends boolean | undefined = undefined,
  >(
    rootId: NodeId<AllNodeTypes<G>>,
    options: InternalSubgraphOptions<G, EK, NK, P, C>,
  ) => Promise<SubgraphResult<G, NK, SubgraphResultEdgeKinds<G, EK, C>, P>>;
  algorithmsAtCoordinate: (
    coordinate: ReadCoordinate,
  ) => InternalGraphAlgorithms<G>;
  identityAtCoordinate: (coordinate: ReadCoordinate) => IdentityReadFacade<G>;
  /**
   * @internal The full identity service context this Store builds writes and
   * reads against — reached by the transition-log/replay module functions
   * (`pruneIdentityTransitions`, and `store.identity.replay` /
   * `transitionsOf`), which are plain functions over
   * `IdentityServiceContext<G>` like every other identity algorithm, rather
   * than Store methods. Throws when the graph never declared `identity: {}`,
   * the same guard `identityAtCoordinate` applies.
   */
  identityContext: () => IdentityServiceContext<G>;
  rebuildIdentityClosure: () => Promise<void>;
  validateIdentity: () => Promise<void>;
  /**
   * Deletes one node under an explicit {@link NodeDeletePolicy}, going through
   * `executeNodeDelete` — the SAME entry point (fused-atomic-or-portable
   * routing included) the public collection facade uses — against `target`
   * directly. The public collection `delete(id)` takes no options by design
   * (a merge-only flag does not belong on it, the `bulkInsert` precedent), so
   * a caller that needs a non-default policy reaches an internal port
   * instead.
   *
   * This Store-scoped variant builds its OWN operation context — an
   * immediate (unbuffered) hook runner and `attempt: 1` — so it is correct
   * only for a caller managing its own transaction directly against the raw
   * backend, or calling against the root backend with no enclosing
   * transaction at all, OUTSIDE any `store.transaction` callback: nothing
   * here is aware of a `store.transaction` in progress, so a caller invoking
   * this INSIDE one would report `onOperationEnd` for the delete immediately,
   * even if that outer transaction later rolls back. A caller already inside
   * a `store.transaction` callback MUST use
   * {@link transactionDeleteNodeWithPolicy} instead, which reaches that
   * transaction's own buffered hook runner and attempt — every production
   * caller (merge apply) does this today.
   *
   * `target` accepts the root {@link GraphBackend} itself, not only a
   * `TransactionBackend`, on purpose: `transactionDeleteNodeWithPolicy` is
   * always transaction-scoped, and a transaction-scoped backend never
   * exposes the fused atomic delete command (see `executeNodeDelete`'s
   * `resolveAtomicNodeDeleteBatchExecutor` call) — so calling THIS port
   * directly against the root backend is the only way, in production or in a
   * test, to exercise the routing decision between the fused and portable
   * delete paths at all.
   */
  deleteNodeWithPolicy: (
    target: GraphBackend | TransactionBackend,
    work: Readonly<{ kind: string; id: string }>,
    policy?: NodeDeletePolicy,
  ) => Promise<void>;
  /**
   * Validates one final resolved node write set, then clears the affected
   * nodes' claim rows so its upserts may take their approved keys in any order,
   * and re-takes the complete claim set once the writes have landed. The caller
   * must supply a transaction-bound backend.
   *
   * The clear is by OWNER, so it takes every claim the affected nodes hold —
   * uniqueness and `disjointWith` alike — and the rebuild therefore goes through
   * the same claim writer an ordinary create uses rather than a uniqueness-only
   * insert. See `store/claims/resolved-node-claims.ts`.
   */
  applyResolvedNodeUniqueness: <Output>(
    target: TransactionBackend,
    writes: Readonly<{
      upserts: readonly Readonly<{
        kind: string;
        id: string;
        props: Readonly<Record<string, unknown>>;
      }>[];
      releases: readonly Readonly<{ kind: string; id: string }>[];
    }>,
    apply: () => Promise<Output>,
  ) => Promise<Output>;
  /**
   * @internal Reads the graph's identity assertions in transfer shape, honoring
   * this store's SQL binding. Used by interchange export, base-version
   * fingerprinting, and merge staging/diff.
   */
  readCurrentIdentityAssertions: (
    mode: "state" | "archival",
    options?: Readonly<{
      nodeKinds?: readonly string[];
      includeDeleted?: boolean;
    }>,
  ) => Promise<
    readonly Readonly<{
      id: string;
      relation: "same" | "different";
      a: Readonly<{ kind: string; id: string }>;
      b: Readonly<{ kind: string; id: string }>;
      validFrom: string;
      validTo?: string | undefined;
      endedBy?: Readonly<{ kind: string; id: string }> | undefined;
    }>[]
  >;
  /**
   * Live nodes (registry kinds only) sharing any of the given bare ids —
   * the cross-kind peer set same-id folding would join. Used by graph-merge's
   * plan-time contradiction simulation to seed its node universe.
   */
  liveNodesSharingIds: (
    ids: readonly string[],
    target?: GraphBackend | TransactionBackend,
  ) => Promise<readonly Readonly<{ kind: string; id: string }>[]>;
  /**
   * Every stored assertion row (ended rows included) for the given assertion
   * ids — the rows the import coordinator's id-conflict check compares
   * against. Used by graph-merge to validate the one-id-one-truth invariant
   * at plan time and inside the commit transaction.
   */
  identityAssertionRowsByIds: (
    ids: readonly string[],
    target?: GraphBackend | TransactionBackend,
  ) => Promise<
    ReadonlyMap<
      string,
      Readonly<{
        id: string;
        relation: "same" | "different";
        a: Readonly<{ kind: string; id: string }>;
        b: Readonly<{ kind: string; id: string }>;
        validFrom: string;
        validTo?: string | undefined;
        endedBy?: Readonly<{ kind: string; id: string }> | undefined;
      }>
    >
  >;
  /**
   * The CURRENT structural identity class (materialized closure: folds plus
   * asserted links) of each reference, keyed by `refKey` — the
   * `JSON.stringify([kind, id])` serialization exported from
   * `identity/service`, which callers must use to probe the returned map. A
   * missing node coalesces to its singleton. Used by graph-merge's fold-peer
   * window guard to detect class-transitive drift in the plan→commit window.
   */
  structuralIdentityClasses: (
    references: readonly Readonly<{ kind: string; id: string }>[],
    target?: GraphBackend | TransactionBackend,
  ) => Promise<
    ReadonlyMap<string, readonly Readonly<{ kind: string; id: string }>[]>
  >;
  identityAssertionsAtTarget: (
    target: GraphBackend | TransactionBackend,
    mode?: "state" | "archival",
  ) => Promise<
    readonly Readonly<{
      id: string;
      relation: "same" | "different";
      a: Readonly<{ kind: string; id: string }>;
      b: Readonly<{ kind: string; id: string }>;
      validFrom: string;
      validTo?: string | undefined;
      endedBy?: Readonly<{ kind: string; id: string }> | undefined;
    }>[]
  >;
  readIdentityAssertionPageAtTarget: (
    target: GraphBackend | TransactionBackend,
    mode: "state" | "archival",
    options: Readonly<{
      nodeKinds?: readonly string[];
      includeDeleted?: boolean;
      after?: string;
      limit: number;
    }>,
  ) => Promise<
    Readonly<{
      assertions: readonly Readonly<{
        id: string;
        relation: "same" | "different";
        a: Readonly<{ kind: string; id: string }>;
        b: Readonly<{ kind: string; id: string }>;
        validFrom: string;
        validTo?: string | undefined;
        endedBy?: Readonly<{ kind: string; id: string }> | undefined;
      }>[];
      nextAfter?: string;
      done: boolean;
    }>
  >;
  lockIdentityImportTarget: (
    target: Readonly<
      BackendIdentity &
        GraphEntityReadBackend &
        SchemaReadBackend &
        QueryExecutionBackend &
        SqlCompilationBackend &
        RawQueryExecutionBackend &
        Pick<GraphBackend, "executeStatement">
    >,
  ) => Promise<void>;
  foldImportedIdentityNodes: (
    target: Readonly<
      BackendIdentity &
        GraphEntityReadBackend &
        SchemaReadBackend &
        QueryExecutionBackend &
        SqlCompilationBackend &
        RawQueryExecutionBackend &
        Pick<GraphBackend, "executeStatement">
    >,
    references: readonly Readonly<{ kind: string; id: string }>[],
  ) => Promise<void>;
  /**
   * Item E.2: detaches a node import purges AFTER `foldImportedIdentityNodes`
   * already folded it into identity for this attempt's batch — see
   * `assertImportedRequiredPartsAttached` (`src/interchange/import.ts`).
   */
  detachDeletedImportedIdentityNode: (
    target: Readonly<
      BackendIdentity &
        GraphEntityReadBackend &
        SchemaReadBackend &
        QueryExecutionBackend &
        SqlCompilationBackend &
        RawQueryExecutionBackend &
        Pick<GraphBackend, "executeStatement">
    >,
    reference: Readonly<{ kind: string; id: string }>,
  ) => Promise<void>;
  importIdentityAssertionsAtTarget: (
    target: Readonly<
      BackendIdentity &
        GraphEntityReadBackend &
        SchemaReadBackend &
        QueryExecutionBackend &
        SqlCompilationBackend &
        RawQueryExecutionBackend &
        Pick<GraphBackend, "executeStatement">
    >,
    assertions: readonly Readonly<{
      id: string;
      relation: "same" | "different";
      a: Readonly<{ kind: string; id: string }>;
      b: Readonly<{ kind: string; id: string }>;
      validFrom: string;
      validTo?: string | undefined;
      endedBy?: Readonly<{ kind: string; id: string }> | undefined;
    }>[],
    mode: "state" | "archival",
  ) => Promise<Readonly<{ created: number; skipped: number }>>;
  /**
   * @internal Reads one bounded page of a graph's ARCHIVAL identity
   * transitions, ordered oldest first — the archival export's sole reader,
   * mirroring `readIdentityAssertionPageAtTarget` above.
   */
  readIdentityTransitionPageAtTarget: (
    target: GraphBackend | TransactionBackend,
    options: Readonly<{ after?: IdentityTransitionCursor; limit: number }>,
  ) => Promise<
    Readonly<{
      transitions: readonly IdentityTransitionTransfer[];
      nextAfter?: IdentityTransitionCursor;
      done: boolean;
    }>
  >;
  /**
   * @internal Reads a graph's identity transition-retention watermark for
   * archival export; `{ prunedBeforeRevision: 0, ... }` when nothing has been
   * pruned.
   */
  identityTransitionRetentionAtTarget: (
    target: GraphBackend | TransactionBackend,
  ) => Promise<Readonly<{ prunedBeforeRevision: number; prunedAt: string }>>;
  /**
   * @internal Restores archival identity transitions inside an import
   * transaction. `carriedWatermark` is the source graph's own retention
   * watermark from the archival payload, used only when `transitions` is
   * empty (see `importIdentityTransitionsIntoTarget`).
   */
  importIdentityTransitionsAtTarget: (
    target: Readonly<
      BackendIdentity &
        GraphEntityReadBackend &
        SchemaReadBackend &
        QueryExecutionBackend &
        SqlCompilationBackend &
        RawQueryExecutionBackend &
        Pick<GraphBackend, "executeStatement">
    >,
    transitions: readonly IdentityTransitionTransfer[],
    carriedWatermark: number | undefined,
  ) => Promise<Readonly<{ created: number; watermark: number | undefined }>>;
  /**
   * `decision` is the governing merge decision, when the apply runs under one:
   * every identity transition the call causes carries it, so a fold a merged
   * node create triggered is attributed to the merge rather than filed as an
   * anonymous `fold`. `undefined` for an apply with no governing decision.
   */
  applyIdentityMergeAtTarget: (
    target: GraphBackend | TransactionBackend,
    retractions: readonly Readonly<{
      id: string;
      relation: "same" | "different";
      a: Readonly<{ kind: string; id: string }>;
      b: Readonly<{ kind: string; id: string }>;
      validFrom: string;
      validTo?: string | undefined;
      endedBy?: Readonly<{ kind: string; id: string }> | undefined;
    }>[],
    assertions: readonly Readonly<{
      id: string;
      relation: "same" | "different";
      a: Readonly<{ kind: string; id: string }>;
      b: Readonly<{ kind: string; id: string }>;
      validFrom: string;
      validTo?: string | undefined;
      endedBy?: Readonly<{ kind: string; id: string }> | undefined;
    }>[],
    decision?: IdentityDecisionProvenance,
  ) => Promise<Readonly<{ created: number; retracted: number }>>;
  /**
   * Proves the identity classes of `seeds` carry no contradiction in the state
   * the caller's transaction has just written — the post-write half of
   * graph-merge's identity correctness, scoped to the classes the merge
   * touched. A refusal aborts the caller's transaction; identity-disabled
   * graphs resolve immediately.
   */
  assertIdentityClassesConsistentAtTarget: (
    target: GraphBackend | TransactionBackend,
    seeds: readonly Readonly<{ kind: string; id: string }>[],
  ) => Promise<void>;
}>;

export function storeRuntime<G extends GraphDef>(
  store: Readonly<{ [STORE_RUNTIME]?: StoreRuntime<G> }>,
): StoreRuntime<G> {
  const runtime = store[STORE_RUNTIME];
  if (runtime === undefined) {
    throw new TypeError(
      "Cannot access this Store's runtime port. The Store may come from an incompatible TypeGraph version.",
    );
  }
  return runtime;
}

export function storeBackend<G extends GraphDef>(
  store: Readonly<{ [STORE_RUNTIME]?: StoreRuntime<G> }>,
): GraphBackend {
  return storeRuntime(store).backend;
}

/**
 * Whether TypeGraph itself performs recorded-time capture for `store` — see
 * {@link StoreRuntime.captureEnabled}. Consult this, never the public
 * `historyEnabled` getter, when the decision at hand is specifically about
 * TypeGraph's own recorded relations (a reader of their columns, the
 * capture-only merge-transaction isolation choice, the trusted-import
 * bypass refusal): `historyEnabled` answers "was `history: true`
 * requested," true for an engine-native store too, which never populates
 * those relations.
 */
export function storeCaptureEnabled<G extends GraphDef>(
  store: Readonly<{ [STORE_RUNTIME]?: StoreRuntime<G> }>,
): boolean {
  return requireDefined(
    storeRuntime(store).captureEnabled,
    "Cannot read this Store's capture flag. The Store may come from an incompatible TypeGraph version.",
  );
}

/**
 * The backend a Store's queries execute through — see
 * {@link StoreRuntime.queryBackend}, including its note about hookless Stores.
 */
export function storeQueryBackend<G extends GraphDef>(
  store: Readonly<{ [STORE_RUNTIME]?: StoreRuntime<G> }>,
  target?: GraphBackend | TransactionBackend,
): GraphBackend {
  return storeRuntime(store).queryBackend(target);
}

type TransactionRuntimePort = Readonly<{
  [TRANSACTION_RUNTIME]?: Readonly<{
    backend: TransactionBackend;
    runNodeOperationHooks: TransactionNodeOperationHookRunner;
    deleteNodeWithPolicy: TransactionDeleteNodeWithPolicy;
  }>;
}>;

type TransactionNodeOperationHookRunner = <T>(
  operation: "create" | "update" | "delete",
  kind: string,
  id: string,
  fn: () => Promise<T>,
) => Promise<T>;

/**
 * A node delete bound to the transaction it is invoked from — see
 * {@link transactionDeleteNodeWithPolicy}. Exported so a caller threading this
 * seam through its own call stack (merge apply) names ONE type rather than
 * redeclaring an identical structural alias that could drift from this port's
 * actual shape.
 */
export type TransactionDeleteNodeWithPolicy = (
  work: Readonly<{ kind: string; id: string }>,
  policy?: NodeDeletePolicy,
) => Promise<void>;

/** Returns the full backend for privileged transaction-bound internals. */
export function transactionBackend(
  transaction: TransactionRuntimePort,
): TransactionBackend {
  const runtime = transaction[TRANSACTION_RUNTIME];
  if (runtime === undefined) {
    throw new TypeError(
      "Cannot access this transaction's runtime port. The transaction may come from an incompatible TypeGraph version.",
    );
  }
  return runtime.backend;
}

/** Returns the hook runner paired with a transaction's internal backend. */
export function transactionNodeOperationHookRunner(
  transaction: TransactionRuntimePort,
): TransactionNodeOperationHookRunner {
  const runtime = transaction[TRANSACTION_RUNTIME];
  if (runtime === undefined) {
    throw new TypeError(
      "Cannot access this transaction's runtime port. The transaction may come from an incompatible TypeGraph version.",
    );
  }
  return runtime.runNodeOperationHooks;
}

/**
 * Soft-deletes one node under an explicit {@link NodeDeletePolicy} through
 * THIS transaction's own node-operation context — the buffered hook runner
 * and attempt number `#buildTransactionContext` already built for this
 * transaction's `nodes`/`edges`, not a freshly-minted immediate-hook context
 * scoped to the outer Store. Reaching the outer Store's own hook runner from
 * inside a caller-opened transaction would report `onOperationEnd` for a
 * delete the instant it runs even when the enclosing transaction later rolls
 * back, which is why this delete-behavior-carrying escape hatch is
 * transaction-scoped rather than Store-scoped: the public collection
 * `delete(id)` takes no options by design (a merge-only flag does not belong
 * on it, the `bulkInsert` precedent), so a caller that needs a non-default
 * policy — today, merge apply — reaches this internal port instead.
 */
export function transactionDeleteNodeWithPolicy(
  transaction: TransactionRuntimePort,
  work: Readonly<{ kind: string; id: string }>,
  policy?: NodeDeletePolicy,
): Promise<void> {
  const runtime = transaction[TRANSACTION_RUNTIME];
  if (runtime === undefined) {
    throw new TypeError(
      "Cannot access this transaction's runtime port. The transaction may come from an incompatible TypeGraph version.",
    );
  }
  return runtime.deleteNodeWithPolicy(work, policy);
}
