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
import { type InitialQueryBuilder } from "../query/builder";
import { typeGraphGlobalSymbol } from "../utils/global-symbol";
import { type InternalGraphAlgorithms } from "./algorithms";
import {
  type InternalSubgraphOptions,
  type SubgraphProject,
  type SubgraphResult,
} from "./subgraph";
import { type Edge, type Node, TRANSACTION_RUNTIME } from "./types";

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
