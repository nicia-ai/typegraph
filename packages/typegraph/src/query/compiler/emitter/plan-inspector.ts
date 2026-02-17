import { CompilerInvariantError } from "../../../errors";
import {
  type LimitOffsetPlanNode,
  type LogicalPlan,
  type LogicalPlanNode,
  type ProjectPlanNode,
  type SortPlanNode,
} from "../plan";

export type ProjectPlanShape = Readonly<{
  hasAggregate: boolean;
  hasLimitOffset: boolean;
  hasRecursiveExpand: boolean;
  hasSetOperation: boolean;
  hasSort: boolean;
  hasVectorKnn: boolean;
  limitOffsetNode: LimitOffsetPlanNode | undefined;
  rootProjectNode: ProjectPlanNode;
  sortNode: SortPlanNode | undefined;
}>;

export type SetOperationPlanShape = Readonly<{
  hasLimitOffset: boolean;
  hasSetOperation: boolean;
  hasSort: boolean;
  limitOffsetNode: LimitOffsetPlanNode | undefined;
  sortNode: SortPlanNode | undefined;
}>;

function collectPlanOperations(node: LogicalPlanNode, ops: Set<string>): void {
  ops.add(node.op);

  switch (node.op) {
    case "aggregate":
    case "filter":
    case "join":
    case "limit_offset":
    case "project":
    case "recursive_expand":
    case "sort":
    case "vector_knn": {
      collectPlanOperations(node.input, ops);
      return;
    }
    case "set_op": {
      collectPlanOperations(node.left, ops);
      collectPlanOperations(node.right, ops);
      return;
    }
    case "scan": {
      return;
    }
  }
}

function findUnaryNodeInProjectChain<TNode extends LogicalPlanNode>(
  rootNode: ProjectPlanNode,
  op: TNode["op"],
): TNode | undefined {
  let currentNode: LogicalPlanNode = rootNode.input;

  for (;;) {
    if (currentNode.op === op) {
      return currentNode as TNode;
    }

    switch (currentNode.op) {
      case "aggregate":
      case "filter":
      case "join":
      case "limit_offset":
      case "recursive_expand":
      case "sort":
      case "vector_knn": {
        currentNode = currentNode.input;
        continue;
      }
      case "project":
      case "scan":
      case "set_op": {
        return undefined;
      }
    }
  }
}

function inspectProjectPlan(logicalPlan: LogicalPlan): ProjectPlanShape {
  if (logicalPlan.root.op !== "project") {
    throw new CompilerInvariantError(
      `SQL emitter expected logical plan root to be "project", got "${logicalPlan.root.op}"`,
      { component: "plan-inspector" },
    );
  }

  const operations = new Set<string>();
  collectPlanOperations(logicalPlan.root, operations);

  const limitOffsetNode = findUnaryNodeInProjectChain<LimitOffsetPlanNode>(
    logicalPlan.root,
    "limit_offset",
  );
  const sortNode = findUnaryNodeInProjectChain<SortPlanNode>(
    logicalPlan.root,
    "sort",
  );

  return {
    hasAggregate: operations.has("aggregate"),
    hasLimitOffset: operations.has("limit_offset"),
    hasRecursiveExpand: operations.has("recursive_expand"),
    hasSetOperation: operations.has("set_op"),
    hasSort: operations.has("sort"),
    hasVectorKnn: operations.has("vector_knn"),
    limitOffsetNode,
    rootProjectNode: logicalPlan.root,
    sortNode,
  };
}

export function inspectStandardProjectPlan(
  logicalPlan: LogicalPlan,
): ProjectPlanShape {
  const shape = inspectProjectPlan(logicalPlan);
  if (shape.hasSetOperation) {
    throw new CompilerInvariantError(
      'Standard SQL emitter does not support plans containing "set_op" nodes',
      { component: "plan-inspector" },
    );
  }
  if (shape.hasRecursiveExpand) {
    throw new CompilerInvariantError(
      'Standard SQL emitter does not support plans containing "recursive_expand" nodes',
      { component: "plan-inspector" },
    );
  }
  return shape;
}

export function inspectRecursiveProjectPlan(
  logicalPlan: LogicalPlan,
): ProjectPlanShape {
  const shape = inspectProjectPlan(logicalPlan);
  if (!shape.hasRecursiveExpand) {
    throw new CompilerInvariantError(
      'Recursive SQL emitter expected logical plan to contain a "recursive_expand" node',
      { component: "plan-inspector" },
    );
  }
  if (shape.hasSetOperation) {
    throw new CompilerInvariantError(
      'Recursive SQL emitter does not support plans containing "set_op" nodes',
      { component: "plan-inspector" },
    );
  }
  return shape;
}

function findTopLevelLimitOffsetNode(
  rootNode: LogicalPlanNode,
): LimitOffsetPlanNode | undefined {
  let currentNode: LogicalPlanNode = rootNode;

  for (;;) {
    if (currentNode.op === "limit_offset") {
      return currentNode;
    }

    switch (currentNode.op) {
      case "aggregate":
      case "filter":
      case "join":
      case "project":
      case "recursive_expand":
      case "sort":
      case "vector_knn": {
        currentNode = currentNode.input;
        continue;
      }
      case "scan":
      case "set_op": {
        return undefined;
      }
    }
  }
}

function findTopLevelSortNode(
  rootNode: LogicalPlanNode,
): SortPlanNode | undefined {
  let currentNode: LogicalPlanNode = rootNode;

  for (;;) {
    if (currentNode.op === "sort") {
      return currentNode;
    }

    switch (currentNode.op) {
      case "aggregate":
      case "filter":
      case "join":
      case "limit_offset":
      case "project":
      case "recursive_expand":
      case "vector_knn": {
        currentNode = currentNode.input;
        continue;
      }
      case "scan":
      case "set_op": {
        return undefined;
      }
    }
  }
}

export function inspectSetOperationPlan(
  logicalPlan: LogicalPlan,
): SetOperationPlanShape {
  const operations = new Set<string>();
  collectPlanOperations(logicalPlan.root, operations);

  if (!operations.has("set_op")) {
    throw new CompilerInvariantError(
      'Set-operation SQL emitter expected logical plan to contain a "set_op" node',
      { component: "plan-inspector" },
    );
  }

  const limitOffsetNode = findTopLevelLimitOffsetNode(logicalPlan.root);
  const sortNode = findTopLevelSortNode(logicalPlan.root);

  return {
    hasLimitOffset: limitOffsetNode !== undefined,
    hasSetOperation: true,
    hasSort: sortNode !== undefined,
    limitOffsetNode,
    sortNode,
  };
}
