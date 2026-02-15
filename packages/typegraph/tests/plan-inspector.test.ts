import { describe, expect, it } from "vitest";

import {
  lowerRecursiveQueryToLogicalPlan,
  lowerSetOperationToLogicalPlan,
  lowerStandardQueryToLogicalPlan,
} from "../src/query/compiler";
import {
  inspectRecursiveProjectPlan,
  inspectSetOperationPlan,
  inspectStandardProjectPlan,
} from "../src/query/compiler/emitter";

describe("plan inspector", () => {
  it("inspects standard plan shape for top-level sort and limit nodes", () => {
    const ast = {
      limit: 5,
      orderBy: [
        {
          direction: "asc" as const,
          field: {
            __type: "field_ref" as const,
            alias: "p",
            path: ["id"] as const,
            valueType: "string" as const,
          },
        },
      ],
      predicates: [],
      projection: {
        fields: [
          {
            outputName: "id",
            source: {
              __type: "field_ref" as const,
              alias: "p",
              path: ["id"] as const,
              valueType: "string" as const,
            },
          },
        ],
      },
      start: {
        alias: "p",
        includeSubClasses: false,
        kinds: ["Person"] as const,
      },
      temporalMode: { mode: "current" as const },
      traversals: [],
    };

    const logicalPlan = lowerStandardQueryToLogicalPlan({
      ast,
      dialect: "sqlite",
      effectiveLimit: 5,
      graphId: "graph_plan_inspector",
    });
    const shape = inspectStandardProjectPlan(logicalPlan);

    expect(shape.hasSort).toBe(true);
    expect(shape.hasLimitOffset).toBe(true);
    expect(shape.sortNode?.op).toBe("sort");
    expect(shape.limitOffsetNode?.op).toBe("limit_offset");
  });

  it("inspects recursive plan shape and requires recursive expand", () => {
    const ast = {
      predicates: [],
      projection: {
        fields: [
          {
            outputName: "friendId",
            source: {
              __type: "field_ref" as const,
              alias: "f",
              path: ["id"] as const,
              valueType: "string" as const,
            },
          },
        ],
      },
      start: {
        alias: "p",
        includeSubClasses: false,
        kinds: ["Person"] as const,
      },
      temporalMode: { mode: "current" as const },
      traversals: [
        {
          direction: "out" as const,
          edgeAlias: "e",
          edgeKinds: ["knows"] as const,
          joinEdgeField: "from_id" as const,
          joinFromAlias: "p",
          nodeAlias: "f",
          nodeKinds: ["Person"] as const,
          optional: false,
          variableLength: {
            cyclePolicy: "prevent" as const,
            maxDepth: 3,
            minDepth: 1,
          },
        },
      ],
    };

    const logicalPlan = lowerRecursiveQueryToLogicalPlan({
      ast,
      dialect: "sqlite",
      graphId: "graph_recursive_inspector",
    });
    const shape = inspectRecursiveProjectPlan(logicalPlan);

    expect(shape.hasRecursiveExpand).toBe(true);
    expect(shape.hasSetOperation).toBe(false);
  });

  it("inspects set-operation top-level shape independently from leaf sort nodes", () => {
    const orderedLeaf = {
      orderBy: [
        {
          direction: "asc" as const,
          field: {
            __type: "field_ref" as const,
            alias: "p",
            path: ["id"] as const,
            valueType: "string" as const,
          },
        },
      ],
      predicates: [],
      projection: {
        fields: [
          {
            outputName: "id",
            source: {
              __type: "field_ref" as const,
              alias: "p",
              path: ["id"] as const,
              valueType: "string" as const,
            },
          },
        ],
      },
      start: {
        alias: "p",
        includeSubClasses: false,
        kinds: ["Person"] as const,
      },
      temporalMode: { mode: "current" as const },
      traversals: [],
    };

    const logicalPlan = lowerSetOperationToLogicalPlan({
      dialect: "sqlite",
      graphId: "graph_set_plan_inspector",
      op: {
        __type: "set_operation",
        left: orderedLeaf,
        operator: "union",
        right: orderedLeaf,
      },
    });
    const shape = inspectSetOperationPlan(logicalPlan);

    expect(shape.hasSetOperation).toBe(true);
    expect(shape.hasSort).toBe(false);
    expect(shape.hasLimitOffset).toBe(false);
  });
});
