/**
 * Store Operations Module
 *
 * Re-exports node and edge operations for clean imports.
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
  executeEdgeFindByEndpoints,
  executeEdgeGetOrCreateByEndpoints,
  executeEdgeHardDelete,
  executeEdgeUpdate,
  executeEdgeUpsertUpdate,
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
  executeNodeFindByConstraint,
  executeNodeGetOrCreateByConstraint,
  executeNodeHardDelete,
  executeNodeUpdate,
  executeNodeUpsertUpdate,
  type NodeOperationContext,
  nodeUpsertDirtyCheck,
} from "./node-operations";
