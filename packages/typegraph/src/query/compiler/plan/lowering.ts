import { CompilerInvariantError } from "../../../errors";
import type {
  AggregateExpr,
  ComposableQuery,
  NodePredicate,
  QueryAst,
  SetOperation,
  VectorSimilarityPredicate,
} from "../../ast";
import { getDialect, type SqlDialect } from "../../dialect";
import {
  resolveVectorAwareLimit,
  runRecursiveTraversalSelectionPass,
  runVectorPredicatePass,
  type VariableLengthTraversal,
} from "../passes";
import type {
  AggregatePlanNode,
  LimitOffsetPlanNode,
  LogicalPlan,
  LogicalPlanNode,
  ProjectPlanNode,
} from "./types";

export type LowerStandardQueryToLogicalPlanInput = Readonly<{
  ast: QueryAst;
  collapsedTraversalCteAlias?: string;
  dialect: SqlDialect;
  effectiveLimit?: number;
  graphId: string;
  vectorPredicate?: VectorSimilarityPredicate;
}>;

export type LowerRecursiveQueryToLogicalPlanInput = Readonly<{
  ast: QueryAst;
  dialect: SqlDialect;
  graphId: string;
  traversal?: VariableLengthTraversal;
}>;

export type LowerSetOperationToLogicalPlanInput = Readonly<{
  dialect: SqlDialect;
  graphId: string;
  op: SetOperation;
}>;

/**
 * Creates a sequential plan node ID generator scoped to a single compilation invocation.
 * IDs are NOT stable across compilations — different compilations of the same query
 * may produce different IDs depending on pass execution order.
 */
function createPlanNodeIdFactory(): () => string {
  let current = 0;
  return function nextPlanNodeId(): string {
    current += 1;
    return `plan_${current.toString(36)}`;
  };
}

function extractAggregateExpressions(ast: QueryAst): readonly AggregateExpr[] {
  const aggregates: AggregateExpr[] = [];

  for (const field of ast.projection.fields) {
    if ("__type" in field.source && field.source.__type === "aggregate") {
      aggregates.push(field.source);
    }
  }

  return aggregates;
}

function getAliasPredicates(
  ast: QueryAst,
  alias: string,
  predicateTargetType: "edge" | "node",
): readonly NodePredicate[] {
  return ast.predicates.filter((predicate) => {
    const targetType = predicate.targetType ?? "node";
    return (
      predicate.targetAlias === alias && targetType === predicateTargetType
    );
  });
}

function wrapWithAliasFilterNode(
  currentNode: LogicalPlanNode,
  ast: QueryAst,
  alias: string,
  predicateTargetType: "edge" | "node",
  nextPlanNodeId: () => string,
): LogicalPlanNode {
  const aliasPredicates = getAliasPredicates(ast, alias, predicateTargetType);
  if (aliasPredicates.length === 0) {
    return currentNode;
  }

  return {
    alias,
    id: nextPlanNodeId(),
    input: currentNode,
    op: "filter",
    predicateTargetType,
    predicates: aliasPredicates.map((predicate) => predicate.expression),
  };
}

function appendAggregateSortLimitAndProjectNodes(
  currentNode: LogicalPlanNode,
  ast: QueryAst,
  nextPlanNodeId: () => string,
  limit: number | undefined,
  collapsedTraversalCteAlias?: string,
): LogicalPlanNode {
  let node = currentNode;

  const aggregateExpressions = extractAggregateExpressions(ast);
  if (
    aggregateExpressions.length > 0 ||
    ast.groupBy !== undefined ||
    ast.having !== undefined
  ) {
    const aggregateNode: AggregatePlanNode = {
      aggregates: aggregateExpressions,
      groupBy: ast.groupBy?.fields ?? [],
      id: nextPlanNodeId(),
      input: node,
      op: "aggregate",
    };
    node =
      ast.having === undefined ?
        aggregateNode
      : { ...aggregateNode, having: ast.having };
  }

  if (ast.orderBy !== undefined && ast.orderBy.length > 0) {
    node = {
      id: nextPlanNodeId(),
      input: node,
      op: "sort",
      orderBy: ast.orderBy,
    };
  }

  if (limit !== undefined || ast.offset !== undefined) {
    const limitOffsetNodeBase: Omit<LimitOffsetPlanNode, "limit" | "offset"> = {
      id: nextPlanNodeId(),
      input: node,
      op: "limit_offset",
    };
    const hasLimit = limit !== undefined;
    const hasOffset = ast.offset !== undefined;

    if (hasLimit && hasOffset) {
      node = {
        ...limitOffsetNodeBase,
        limit,
        offset: ast.offset,
      };
    } else if (hasLimit) {
      node = { ...limitOffsetNodeBase, limit };
    } else if (hasOffset) {
      node = { ...limitOffsetNodeBase, offset: ast.offset };
    } else {
      throw new CompilerInvariantError(
        "limit_offset node requires limit or offset to be present",
      );
    }
  }

  const projectNodeBase: Omit<ProjectPlanNode, "collapsedTraversalAlias"> = {
    fields: ast.projection.fields,
    id: nextPlanNodeId(),
    input: node,
    op: "project",
  };
  return collapsedTraversalCteAlias === undefined ? projectNodeBase : (
      {
        ...projectNodeBase,
        collapsedTraversalAlias: collapsedTraversalCteAlias,
      }
    );
}

type LowerStandardQueryToLogicalPlanNodeInput =
  LowerStandardQueryToLogicalPlanInput &
    Readonly<{
      nextPlanNodeId: () => string;
    }>;

function lowerStandardQueryToLogicalPlanNode(
  input: LowerStandardQueryToLogicalPlanNodeInput,
): LogicalPlanNode {
  const { ast, nextPlanNodeId } = input;

  let currentNode: LogicalPlanNode = {
    alias: ast.start.alias,
    graphId: input.graphId,
    id: nextPlanNodeId(),
    kinds: ast.start.kinds,
    op: "scan",
    source: "nodes",
  };

  currentNode = wrapWithAliasFilterNode(
    currentNode,
    ast,
    ast.start.alias,
    "node",
    nextPlanNodeId,
  );

  for (const traversal of ast.traversals) {
    currentNode = {
      direction: traversal.direction,
      edgeAlias: traversal.edgeAlias,
      edgeKinds: traversal.edgeKinds,
      id: nextPlanNodeId(),
      input: currentNode,
      inverseEdgeKinds: traversal.inverseEdgeKinds ?? [],
      joinFromAlias: traversal.joinFromAlias,
      joinType: traversal.optional ? "left" : "inner",
      nodeAlias: traversal.nodeAlias,
      nodeKinds: traversal.nodeKinds,
      op: "join",
    };

    currentNode = wrapWithAliasFilterNode(
      currentNode,
      ast,
      traversal.edgeAlias,
      "edge",
      nextPlanNodeId,
    );
    currentNode = wrapWithAliasFilterNode(
      currentNode,
      ast,
      traversal.nodeAlias,
      "node",
      nextPlanNodeId,
    );
  }

  if (input.vectorPredicate !== undefined) {
    currentNode = {
      id: nextPlanNodeId(),
      input: currentNode,
      op: "vector_knn",
      predicate: input.vectorPredicate,
    };
  }

  return appendAggregateSortLimitAndProjectNodes(
    currentNode,
    ast,
    nextPlanNodeId,
    input.effectiveLimit,
    input.collapsedTraversalCteAlias,
  );
}

type LowerRecursiveQueryToLogicalPlanNodeInput =
  LowerRecursiveQueryToLogicalPlanInput &
    Readonly<{
      nextPlanNodeId: () => string;
    }>;

function lowerRecursiveQueryToLogicalPlanNode(
  input: LowerRecursiveQueryToLogicalPlanNodeInput,
): LogicalPlanNode {
  const { ast, nextPlanNodeId } = input;
  const traversal =
    input.traversal ?? runRecursiveTraversalSelectionPass(input.ast);

  let currentNode: LogicalPlanNode = {
    alias: ast.start.alias,
    graphId: input.graphId,
    id: nextPlanNodeId(),
    kinds: ast.start.kinds,
    op: "scan",
    source: "nodes",
  };

  currentNode = wrapWithAliasFilterNode(
    currentNode,
    ast,
    ast.start.alias,
    "node",
    nextPlanNodeId,
  );

  currentNode = {
    edgeAlias: traversal.edgeAlias,
    edgeKinds: traversal.edgeKinds,
    id: nextPlanNodeId(),
    input: currentNode,
    inverseEdgeKinds: traversal.inverseEdgeKinds ?? [],
    nodeAlias: traversal.nodeAlias,
    nodeKinds: traversal.nodeKinds,
    op: "recursive_expand",
    traversal: traversal.variableLength,
  };

  currentNode = wrapWithAliasFilterNode(
    currentNode,
    ast,
    traversal.edgeAlias,
    "edge",
    nextPlanNodeId,
  );
  currentNode = wrapWithAliasFilterNode(
    currentNode,
    ast,
    traversal.nodeAlias,
    "node",
    nextPlanNodeId,
  );

  return appendAggregateSortLimitAndProjectNodes(
    currentNode,
    ast,
    nextPlanNodeId,
    ast.limit,
  );
}

function lowerComposableQueryToLogicalPlanNode(
  query: ComposableQuery,
  dialect: SqlDialect,
  graphId: string,
  nextPlanNodeId: () => string,
): LogicalPlanNode {
  if ("__type" in query) {
    return lowerSetOperationToLogicalPlanNode(
      query,
      graphId,
      dialect,
      nextPlanNodeId,
    );
  }

  const hasVariableLengthTraversal = query.traversals.some(
    (traversal) => traversal.variableLength !== undefined,
  );
  if (hasVariableLengthTraversal) {
    return lowerRecursiveQueryToLogicalPlanNode({
      ast: query,
      dialect,
      graphId,
      nextPlanNodeId,
    });
  }

  const vectorPredicate = runVectorPredicatePass(
    query,
    getDialect(dialect),
  ).vectorPredicate;
  const effectiveLimit = resolveVectorAwareLimit(query.limit, vectorPredicate);
  const loweringInput = {
    ast: query,
    dialect,
    graphId,
    nextPlanNodeId,
    ...(effectiveLimit === undefined ? {} : { effectiveLimit }),
    ...(vectorPredicate === undefined ? {} : { vectorPredicate }),
  };
  return lowerStandardQueryToLogicalPlanNode(loweringInput);
}

function lowerSetOperationToLogicalPlanNode(
  op: SetOperation,
  graphId: string,
  dialect: SqlDialect,
  nextPlanNodeId: () => string,
): LogicalPlanNode {
  let currentNode: LogicalPlanNode = {
    id: nextPlanNodeId(),
    left: lowerComposableQueryToLogicalPlanNode(
      op.left,
      dialect,
      graphId,
      nextPlanNodeId,
    ),
    op: "set_op",
    operator: op.operator,
    right: lowerComposableQueryToLogicalPlanNode(
      op.right,
      dialect,
      graphId,
      nextPlanNodeId,
    ),
  };

  if (op.orderBy !== undefined && op.orderBy.length > 0) {
    currentNode = {
      id: nextPlanNodeId(),
      input: currentNode,
      op: "sort",
      orderBy: op.orderBy,
    };
  }

  if (op.limit !== undefined || op.offset !== undefined) {
    const limitOffsetBase = {
      id: nextPlanNodeId(),
      input: currentNode,
      op: "limit_offset" as const,
    };
    if (op.limit !== undefined && op.offset !== undefined) {
      currentNode = { ...limitOffsetBase, limit: op.limit, offset: op.offset };
    } else if (op.limit === undefined) {
      currentNode = { ...limitOffsetBase, offset: op.offset! };
    } else {
      currentNode = { ...limitOffsetBase, limit: op.limit };
    }
  }

  return currentNode;
}

export function lowerStandardQueryToLogicalPlan(
  input: LowerStandardQueryToLogicalPlanInput,
): LogicalPlan {
  const nextPlanNodeId = createPlanNodeIdFactory();
  return {
    metadata: {
      dialect: input.dialect,
      graphId: input.graphId,
    },
    root: lowerStandardQueryToLogicalPlanNode({
      ...input,
      nextPlanNodeId,
    }),
  };
}

export function lowerRecursiveQueryToLogicalPlan(
  input: LowerRecursiveQueryToLogicalPlanInput,
): LogicalPlan {
  const nextPlanNodeId = createPlanNodeIdFactory();
  return {
    metadata: {
      dialect: input.dialect,
      graphId: input.graphId,
    },
    root: lowerRecursiveQueryToLogicalPlanNode({
      ...input,
      nextPlanNodeId,
    }),
  };
}

export function lowerSetOperationToLogicalPlan(
  input: LowerSetOperationToLogicalPlanInput,
): LogicalPlan {
  const nextPlanNodeId = createPlanNodeIdFactory();
  return {
    metadata: {
      dialect: input.dialect,
      graphId: input.graphId,
    },
    root: lowerSetOperationToLogicalPlanNode(
      input.op,
      input.graphId,
      input.dialect,
      nextPlanNodeId,
    ),
  };
}
