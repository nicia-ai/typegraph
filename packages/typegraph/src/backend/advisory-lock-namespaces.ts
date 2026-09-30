/**
 * The canonical graph-write lock namespace shared by backend SQL fusion and
 * recorded-capture's portable lock statement.
 *
 * This namespace occupies one fixed position in the global lock order. A
 * second spelling would create a disjoint exclusion set, not an optimization.
 */
export const RECORDED_GRAPH_WRITE_ADVISORY_LOCK_NAMESPACE =
  "typegraph:recorded-graph-write";

/**
 * The per-allocation lock of the PostgreSQL working-copy manager: every durable
 * operation, delivery mark and destroy on one allocation serializes on it. A
 * namespace of its own keeps its key space disjoint from the graph locks above,
 * whose keys are graph ids.
 */
export const WORKING_COPY_ALLOCATION_ADVISORY_LOCK_NAMESPACE =
  "typegraph:working-copy-allocation";
