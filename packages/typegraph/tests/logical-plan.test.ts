import { describe, expect, it } from "vitest";

import {
  type FieldRef,
  type PredicateExpression,
  type QueryAst,
  type SetOperation,
  type VectorSimilarityPredicate,
} from "../src/query/ast";
import {
  type LogicalPlanNode,
  lowerRecursiveQueryToLogicalPlan,
  lowerSetOperationToLogicalPlan,
  lowerStandardQueryToLogicalPlan,
} from "../src/query/compiler";
import { jsonPointer } from "../src/query/json-pointer";

function createIdField(alias: string): FieldRef {
  return {
    __type: "field_ref",
    alias,
    path: ["id"],
  };
}

function createStringPropertyField(alias: string, field: string): FieldRef {
  return {
    __type: "field_ref",
    alias,
    jsonPointer: jsonPointer([field]),
    path: ["props", field],
    valueType: "string",
  };
}

function collectPlanOperations(node: LogicalPlanNode): readonly string[] {
  switch (node.op) {
    case "scan": {
      return [node.op];
    }
    case "set_op": {
      return [
        node.op,
        ...collectPlanOperations(node.left),
        ...collectPlanOperations(node.right),
      ];
    }
    case "aggregate":
    case "filter":
    case "join":
    case "limit_offset":
    case "project":
    case "recursive_expand":
    case "sort":
    case "vector_knn": {
      return [node.op, ...collectPlanOperations(node.input)];
    }
  }
}

function createBaseAst(extra: Partial<QueryAst> = {}): QueryAst {
  return {
    start: {
      alias: "p",
      includeSubClasses: false,
      kinds: ["Person"],
    },
    traversals: [],
    predicates: [],
    projection: {
      fields: [
        {
          outputName: "id",
          source: createIdField("p"),
        },
      ],
    },
    temporalMode: { mode: "current" },
    ...extra,
  };
}

describe("logical plan lowering", () => {
  it("lowers simple query into scan/filter/project pipeline", () => {
    const predicateExpression: PredicateExpression = {
      __type: "comparison",
      left: createStringPropertyField("p", "name"),
      op: "eq",
      right: {
        __type: "literal",
        value: "Alice",
      },
    };

    const ast = createBaseAst({
      predicates: [
        {
          expression: predicateExpression,
          targetAlias: "p",
        },
      ],
    });

    const plan = lowerStandardQueryToLogicalPlan({
      ast,
      dialect: "sqlite",
      effectiveLimit: 25,
      graphId: "graph_1",
    });

    expect(plan.metadata.graphId).toBe("graph_1");
    expect(plan.root.op).toBe("project");
    expect(collectPlanOperations(plan.root)).toEqual([
      "project",
      "limit_offset",
      "filter",
      "scan",
    ]);
  });

  it("adds join and vector nodes for traversal vector queries", () => {
    const vectorPredicate: VectorSimilarityPredicate = {
      __type: "vector_similarity",
      field: {
        __type: "field_ref",
        alias: "f",
        jsonPointer: jsonPointer(["embedding"]),
        path: ["props", "embedding"],
        valueType: "embedding",
      },
      limit: 8,
      metric: "cosine",
      queryEmbedding: [0.1, 0.2, 0.3],
    };

    const ast = createBaseAst({
      predicates: [
        {
          expression: vectorPredicate,
          targetAlias: "f",
        },
      ],
      projection: {
        fields: [
          {
            outputName: "friendId",
            source: createIdField("f"),
          },
        ],
      },
      traversals: [
        {
          direction: "out",
          edgeAlias: "e",
          edgeKinds: ["knows"],
          joinEdgeField: "from_id",
          joinFromAlias: "p",
          nodeAlias: "f",
          nodeKinds: ["Person"],
          optional: false,
        },
      ],
    });

    const plan = lowerStandardQueryToLogicalPlan({
      ast,
      dialect: "postgres",
      effectiveLimit: 8,
      graphId: "graph_2",
      vectorPredicate,
    });

    expect(collectPlanOperations(plan.root)).toEqual([
      "project",
      "limit_offset",
      "vector_knn",
      "filter",
      "join",
      "scan",
    ]);
  });

  it("adds aggregate node for grouped projections", () => {
    const ast = createBaseAst({
      groupBy: { fields: [createIdField("p")] },
      projection: {
        fields: [
          {
            outputName: "id",
            source: createIdField("p"),
          },
          {
            outputName: "count",
            source: {
              __type: "aggregate",
              field: createIdField("p"),
              function: "count",
            },
          },
        ],
      },
    });

    const plan = lowerStandardQueryToLogicalPlan({
      ast,
      dialect: "sqlite",
      graphId: "graph_3",
    });

    expect(collectPlanOperations(plan.root)).toEqual([
      "project",
      "aggregate",
      "scan",
    ]);
  });

  it("lowers recursive traversals with recursive_expand", () => {
    const ast = createBaseAst({
      limit: 20,
      predicates: [
        {
          expression: {
            __type: "comparison",
            left: createStringPropertyField("p", "name"),
            op: "eq",
            right: {
              __type: "literal",
              value: "Alice",
            },
          },
          targetAlias: "p",
        },
        {
          expression: {
            __type: "comparison",
            left: createStringPropertyField("e", "strength"),
            op: "eq",
            right: {
              __type: "literal",
              value: "high",
            },
          },
          targetAlias: "e",
          targetType: "edge",
        },
        {
          expression: {
            __type: "comparison",
            left: createStringPropertyField("f", "city"),
            op: "eq",
            right: {
              __type: "literal",
              value: "Seattle",
            },
          },
          targetAlias: "f",
        },
      ],
      projection: {
        fields: [
          {
            outputName: "friendId",
            source: createIdField("f"),
          },
        ],
      },
      traversals: [
        {
          direction: "out",
          edgeAlias: "e",
          edgeKinds: ["knows"],
          joinEdgeField: "from_id",
          joinFromAlias: "p",
          nodeAlias: "f",
          nodeKinds: ["Person"],
          optional: false,
          variableLength: {
            cyclePolicy: "prevent",
            maxDepth: 5,
            minDepth: 1,
          },
        },
      ],
    });

    const plan = lowerRecursiveQueryToLogicalPlan({
      ast,
      dialect: "sqlite",
      graphId: "graph_recursive",
    });

    expect(collectPlanOperations(plan.root)).toEqual([
      "project",
      "limit_offset",
      "filter",
      "filter",
      "recursive_expand",
      "filter",
      "scan",
    ]);
  });

  it("lowers nested set operations with ordering and pagination", () => {
    const leftLeaf = createBaseAst({
      predicates: [
        {
          expression: {
            __type: "comparison",
            left: createStringPropertyField("p", "name"),
            op: "eq",
            right: {
              __type: "literal",
              value: "Alice",
            },
          },
          targetAlias: "p",
        },
      ],
    });
    const middleLeaf = createBaseAst({
      predicates: [
        {
          expression: {
            __type: "comparison",
            left: createStringPropertyField("p", "name"),
            op: "eq",
            right: {
              __type: "literal",
              value: "Bob",
            },
          },
          targetAlias: "p",
        },
      ],
    });
    const rightLeaf = createBaseAst({
      predicates: [
        {
          expression: {
            __type: "comparison",
            left: createStringPropertyField("p", "name"),
            op: "eq",
            right: {
              __type: "literal",
              value: "Carol",
            },
          },
          targetAlias: "p",
        },
      ],
    });
    const op: SetOperation = {
      __type: "set_operation",
      left: leftLeaf,
      limit: 10,
      offset: 5,
      operator: "union",
      orderBy: [
        {
          direction: "asc",
          field: createIdField("p"),
        },
      ],
      right: {
        __type: "set_operation",
        left: middleLeaf,
        operator: "except",
        right: rightLeaf,
      },
    };

    const plan = lowerSetOperationToLogicalPlan({
      dialect: "postgres",
      graphId: "graph_set_op",
      op,
    });

    expect(collectPlanOperations(plan.root)).toEqual([
      "limit_offset",
      "sort",
      "set_op",
      "project",
      "filter",
      "scan",
      "set_op",
      "project",
      "filter",
      "scan",
      "project",
      "filter",
      "scan",
    ]);
  });
});
