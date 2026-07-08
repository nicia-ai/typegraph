import {
  type DeleteEdgeParams,
  type DeleteEdgesBatchParams,
  type DeleteNodeParams,
  type GraphBackend,
  type HardDeleteEdgeParams,
  type HardDeleteNodeParams,
  type InsertEdgeParams,
  type InsertNodeParams,
  type TransactionBackend,
  type UpdateEdgeParams,
  type UpdateNodeParams,
} from "../../backend/types";
import { type Assert, type Equal } from "../../utils/type-assert";

/**
 * The graph-entity write surface that recorded-time capture must wrap. Both
 * factories — the transaction delegate and the autocommit wrapper — must
 * override every method here, or a write of that kind silently bypasses capture
 * and history diverges from live state. The two factories stay as explicit,
 * type-checked overrides (heterogeneous signatures make a single generic
 * dispatch either unsafe or a Proxy), so these lists are the shared checklist
 * and `recorded-capture-write-parity.test.ts` fails if either factory leaves
 * any of them unwrapped. A maintainer adding a write method adds it here and to
 * both factories.
 *
 * `REQUIRED` methods exist on every `GraphBackend`; `OPTIONAL` methods are
 * wrapped only when the wrapped backend provides them (capture falls back to the
 * required primitives otherwise).
 */
export const RECORDED_REQUIRED_WRITE_METHODS = [
  "insertNode",
  "updateNode",
  "deleteNode",
  "hardDeleteNode",
  "insertEdge",
  "updateEdge",
  "deleteEdge",
  "hardDeleteEdge",
] as const satisfies readonly (keyof GraphBackend)[];

export const RECORDED_OPTIONAL_WRITE_METHODS = [
  "insertNodeNoReturn",
  "insertNodesBatch",
  "insertNodesBatchReturning",
  "insertEdgeNoReturn",
  "insertEdgesBatch",
  "insertEdgesBatchReturning",
  "deleteEdgesBatch",
  "hardDeleteEdgesBatch",
] as const satisfies readonly (keyof GraphBackend)[];

// ============================================================
// Compile-time capture-completeness guard
// ============================================================
//
// The two lists above are the hand-maintained checklist the factories override.
// A list that drifts from the backend's real graph-entity write surface would
// let a write delegate straight to the wrapped backend UNCAPTURED, so history
// silently diverges from live state. Rather than trust the lists to stay in sync
// by review, the surface is *derived from the type* and asserted equal to them:
// a graph-entity write is exactly a backend method whose first parameter is one
// of the node/edge mutation param shapes, so adding such a method (e.g. a bulk
// replace taking `readonly InsertNodeParams[]`) without listing it — or a stale
// / typo'd list entry — fails `pnpm typecheck`, not silently at runtime.

/** Function-valued keys of `T` (optional methods included, `undefined` stripped). */
type FunctionKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends (...args: never[]) => unknown ? K
  : never;
}[keyof T];

/** First-parameter shapes that mark a backend method a graph-entity write. */
type GraphEntityWriteParam =
  | InsertNodeParams
  | UpdateNodeParams
  | DeleteNodeParams
  | HardDeleteNodeParams
  | InsertEdgeParams
  | UpdateEdgeParams
  | DeleteEdgeParams
  | HardDeleteEdgeParams
  | readonly InsertNodeParams[]
  | readonly InsertEdgeParams[]
  | DeleteEdgesBatchParams;

/** Backend methods whose signature marks them a graph-entity write. */
type DerivedGraphEntityWriteMethod = {
  [K in FunctionKeys<GraphBackend>]: Parameters<
    NonNullable<GraphBackend[K]>
  >[0] extends GraphEntityWriteParam ?
    K
  : never;
}[FunctionKeys<GraphBackend>];

type ListedRecordedWriteMethod =
  | (typeof RECORDED_REQUIRED_WRITE_METHODS)[number]
  | (typeof RECORDED_OPTIONAL_WRITE_METHODS)[number];

// If this line errors, the recorded-capture write lists no longer match the
// backend's graph-entity write surface — reconcile RECORDED_*_WRITE_METHODS (and
// both capture factories) with the method the error names.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time assertion
type _captureSurfaceIsComplete = Assert<
  Equal<ListedRecordedWriteMethod, DerivedGraphEntityWriteMethod>
>;

// The tx-scoped capture decorator overrides only writes — it deliberately does
// NOT override `transaction`, relying on TransactionBackend omitting it (a
// transaction-scoped backend exposes no nested-transaction primitive). Pin that
// contract: if `transaction` ever re-enters TransactionBackend, this fails — a
// signal that the decorator must now wrap it too, or a nested transaction could
// route writes past capture.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time assertion
type _txBackendOmitsTransaction = Assert<
  Equal<Extract<keyof TransactionBackend, "transaction">, never>
>;
