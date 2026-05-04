import type {
  AggregateExpr,
  FieldRef,
  FulltextMatchPredicate,
  OrderSpec,
  PredicateExpression,
  ProjectedField,
  SetOperationType,
  TraversalDirection,
  VariableLengthSpec,
  VectorSimilarityPredicate,
} from "../../ast";
import type { SqlDialect } from "../../dialect";

export type LogicalPlanNode =
  | ScanPlanNode
  | FilterPlanNode
  | JoinPlanNode
  | AggregatePlanNode
  | SortPlanNode
  | LimitOffsetPlanNode
  | VectorKnnPlanNode
  | FulltextMatchPlanNode
  | RecursiveExpandPlanNode
  | SetOpPlanNode
  | ProjectPlanNode;

export type LogicalPlan = Readonly<{
  metadata: Readonly<{
    dialect: SqlDialect;
    graphId: string;
  }>;
  root: LogicalPlanNode;
}>;

export type ScanPlanNode = Readonly<{
  alias: string;
  graphId: string;
  id: string;
  kinds: readonly string[];
  op: "scan";
  source: "nodes" | "edges" | "embeddings";
}>;

export type FilterPlanNode = Readonly<{
  alias: string;
  id: string;
  input: LogicalPlanNode;
  op: "filter";
  predicateTargetType: "edge" | "node";
  predicates: readonly PredicateExpression[];
}>;

export type JoinPlanNode = Readonly<{
  direction: TraversalDirection;
  edgeAlias: string;
  edgeKinds: readonly string[];
  id: string;
  input: LogicalPlanNode;
  inverseEdgeKinds: readonly string[];
  joinFromAlias: string;
  joinType: "inner" | "left";
  nodeAlias: string;
  nodeKinds: readonly string[];
  op: "join";
}>;

export type AggregatePlanNode = Readonly<{
  aggregates: readonly AggregateExpr[];
  groupBy: readonly FieldRef[];
  having?: PredicateExpression;
  id: string;
  input: LogicalPlanNode;
  op: "aggregate";
}>;

export type SortPlanNode = Readonly<{
  id: string;
  input: LogicalPlanNode;
  op: "sort";
  orderBy: readonly OrderSpec[];
}>;

type LimitOffsetPlanNodeBase = Readonly<{
  id: string;
  input: LogicalPlanNode;
  op: "limit_offset";
}>;

export type LimitOffsetPlanNode =
  | (LimitOffsetPlanNodeBase & Readonly<{ limit: number; offset?: number }>)
  | (LimitOffsetPlanNodeBase & Readonly<{ limit?: number; offset: number }>);

export type VectorKnnPlanNode = Readonly<{
  id: string;
  input: LogicalPlanNode;
  op: "vector_knn";
  predicate: VectorSimilarityPredicate;
}>;

type FulltextMatchPlanNode = Readonly<{
  id: string;
  input: LogicalPlanNode;
  op: "fulltext_match";
  predicate: FulltextMatchPredicate;
}>;

export type RecursiveExpandPlanNode = Readonly<{
  edgeAlias: string;
  edgeKinds: readonly string[];
  id: string;
  input: LogicalPlanNode;
  inverseEdgeKinds: readonly string[];
  nodeAlias: string;
  nodeKinds: readonly string[];
  op: "recursive_expand";
  traversal: VariableLengthSpec;
}>;

export type SetOpPlanNode = Readonly<{
  id: string;
  left: LogicalPlanNode;
  op: "set_op";
  operator: SetOperationType;
  right: LogicalPlanNode;
}>;

export type ProjectPlanNode = Readonly<{
  collapsedTraversalAlias?: string;
  fields: readonly ProjectedField[];
  id: string;
  input: LogicalPlanNode;
  op: "project";
}>;
