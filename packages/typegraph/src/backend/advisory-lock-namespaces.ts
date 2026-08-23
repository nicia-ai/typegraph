/**
 * The canonical graph-write lock namespace shared by backend SQL fusion and
 * recorded-capture's portable lock statement.
 *
 * This namespace occupies one fixed position in the global lock order. A
 * second spelling would create a disjoint exclusion set, not an optimization.
 */
export const RECORDED_GRAPH_WRITE_ADVISORY_LOCK_NAMESPACE =
  "typegraph:recorded-graph-write";
