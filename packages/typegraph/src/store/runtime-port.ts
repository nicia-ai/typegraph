import { type GraphBackend, type TransactionBackend } from "../backend/types";
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
import {
  type IdentityImportSummary,
  type IdentityTransferAssertion,
} from "../identity/service";
import { type IdentityReadFacadeFor } from "../identity/types";
import { type InitialQueryBuilder } from "../query/builder";
import { typeGraphGlobalSymbol } from "../utils/global-symbol";
import { type InternalGraphAlgorithms } from "./algorithms";
import {
  type InternalSubgraphOptions,
  type SubgraphProject,
  type SubgraphResult,
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
    const P extends SubgraphProject<G, NK, EK> | undefined = undefined,
  >(
    rootId: NodeId<AllNodeTypes<G>>,
    options: InternalSubgraphOptions<G, EK, NK, P>,
  ) => Promise<SubgraphResult<G, NK, EK, P>>;
  algorithmsAtCoordinate: (
    coordinate: ReadCoordinate,
  ) => InternalGraphAlgorithms<G>;
  identityAtCoordinate: (
    coordinate: ReadCoordinate,
  ) => IdentityReadFacadeFor<G>;
  rebuildIdentityClosure: () => Promise<void>;
  validateIdentity: () => Promise<void>;
  identityAssertionsForInterchange: (
    mode: "state" | "archival",
    options?: Readonly<{
      nodeKinds?: readonly string[];
      includeDeleted?: boolean;
    }>,
  ) => Promise<readonly IdentityTransferAssertion[]>;
  identityAssertionsAtTarget: (
    target: GraphBackend | TransactionBackend,
    mode?: "state" | "archival",
  ) => Promise<readonly IdentityTransferAssertion[]>;
  lockIdentityImportTarget: (
    target: GraphBackend | TransactionBackend,
  ) => Promise<void>;
  foldImportedIdentityNodes: (
    target: GraphBackend | TransactionBackend,
    references: readonly Readonly<{ kind: string; id: string }>[],
  ) => Promise<void>;
  importIdentityAssertionsAtTarget: (
    target: GraphBackend | TransactionBackend,
    assertions: readonly IdentityTransferAssertion[],
    mode: "state" | "archival",
  ) => Promise<IdentityImportSummary>;
  applyIdentityMergeAtTarget: (
    target: GraphBackend | TransactionBackend,
    retractionIds: readonly string[],
    assertions: readonly IdentityTransferAssertion[],
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

type TransactionRuntimePort = Readonly<{
  [TRANSACTION_RUNTIME]?: Readonly<{
    backend: TransactionBackend;
    runNodeOperationHooks: TransactionNodeOperationHookRunner;
  }>;
}>;

type TransactionNodeOperationHookRunner = <T>(
  operation: "create" | "update" | "delete",
  kind: string,
  id: string,
  fn: () => Promise<T>,
) => Promise<T>;

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
