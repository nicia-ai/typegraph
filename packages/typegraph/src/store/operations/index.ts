/**
 * Store Operations Module
 *
 * Re-exports node and edge operations for clean imports.
 *
 * ## What this deliberately does NOT re-export
 *
 * The write pipeline's step and sidecar modules — `node-write-pipeline.ts`,
 * `edge-write-pipeline.ts`, `insert-dispatch.ts`, the claim modules,
 * `embedding-sync.ts`, `fulltext-sync.ts` — and `write-transaction.ts`'s
 * `runInWriteTransaction` / `runHookedWriteOperation`. A raw row primitive
 * reached through a convenient barrel is exactly the "a new write path forgot
 * a sidecar" this seam exists to make unspellable, so what this module
 * publishes is the SEAM — {@link runWritePlan}, {@link WritePlan},
 * {@link WriteSession} — and the operations built on it. The step modules keep
 * the exports their own consumers need (the session, plus the two reasoned
 * carve-outs: `provenance/index.ts`'s read-compute-write preludes and
 * `recorded-capture.ts`'s insert dispatch), and nothing reaches them here.
 */

export {
  type EdgeOperationContext,
  edgeUpsertDirtyCheck,
  executeEdgeBulkGetOrCreateByEndpoints,
  executeEdgeCreate,
  executeEdgeCreateBatch,
  executeEdgeCreateNoReturn,
  executeEdgeCreateNoReturnBatch,
  executeEdgeDelete,
  executeEdgeDeleteBatch,
  executeEdgeFindByEndpoints,
  executeEdgeGetOrCreateByEndpoints,
  executeEdgeHardDelete,
  executeEdgeResolvedMutationSet,
  executeEdgeUpdate,
  executeEdgeUpsertUpdate,
  executeEdgeUpsertUpdateBatch,
} from "./edge-operations";
export {
  executeNodeBulkFindByConstraint,
  executeNodeBulkFindByIndex,
  executeNodeBulkGetOrCreateByConstraint,
  executeNodeCreate,
  executeNodeCreateBatch,
  executeNodeCreateNoReturn,
  executeNodeCreateNoReturnBatch,
  executeNodeDelete,
  executeNodeDeleteBatch,
  executeNodeFindByConstraint,
  executeNodeGetOrCreateByConstraint,
  executeNodeHardDelete,
  executeNodeResolvedMutationSet,
  executeNodeUpdate,
  executeNodeUpdateWhere,
  executeNodeUpsertUpdate,
  executeNodeUpsertUpdateBatch,
  type NodeOperationContext,
  nodeUpsertDirtyCheck,
} from "./node-operations";
export { runWritePlan } from "./write-executor";
export {
  edgeWritePlan,
  mixedWritePlan,
  nodeBatchWritePlan,
  nodeWritePlan,
  type RowWorkKind,
  type WritePlan,
} from "./write-plan";
export {
  type EdgeWriteSession,
  type NodeWriteSession,
  type WriteSession,
  type WriteSessionFor,
} from "./write-session";
export { lockSchemaVersionForStoreWrite } from "./write-transaction";
