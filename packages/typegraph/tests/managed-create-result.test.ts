import { describe, expect, it } from "vitest";

import { assertManagedCreateResultMatchesPlan } from "../src/backend/managed-create";
import type {
  EdgeRow,
  ManagedCreatePlan,
  ManagedCreateResult,
  NodeRow,
} from "../src/backend/types";
import { CompilerInvariantError } from "../src/errors";

const TIMESTAMP = "2026-08-22T00:00:00.000Z";

function nodeRow(
  identity: Readonly<{ graphId: string; kind: string; id: string }>,
): NodeRow {
  return {
    graph_id: identity.graphId,
    kind: identity.kind,
    id: identity.id,
    props: {},
    version: 1,
    valid_from: undefined,
    valid_to: undefined,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    deleted_at: undefined,
  };
}

function edgeRow(
  identity: Readonly<{ graphId: string; kind: string; id: string }>,
): EdgeRow {
  return {
    graph_id: identity.graphId,
    kind: identity.kind,
    id: identity.id,
    from_kind: "Person",
    from_id: "from",
    to_kind: "Person",
    to_id: "to",
    props: {},
    valid_from: undefined,
    valid_to: undefined,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    deleted_at: undefined,
  };
}

const NODE_PLAN = {
  entity: "node",
  params: {
    graphId: "expected-graph",
    kind: "Person",
    id: "expected-node",
    props: {},
  },
  idGenerated: true,
  mode: { kind: "ordinary" },
  claims: [],
  projections: [],
} as const satisfies ManagedCreatePlan;

const EDGE_PLAN = {
  entity: "edge",
  params: {
    graphId: "expected-graph",
    kind: "knows",
    id: "expected-edge",
    fromKind: "Person",
    fromId: "from",
    toKind: "Person",
    toId: "to",
    props: {},
  },
} as const satisfies ManagedCreatePlan;

describe("managed create result correlation", () => {
  it.each([
    { graphId: "foreign-graph", kind: "Person", id: "expected-node" },
    { graphId: "expected-graph", kind: "Company", id: "expected-node" },
    { graphId: "expected-graph", kind: "Person", id: "foreign-node" },
  ])(
    "refuses a node row at a foreign identity: $graphId/$kind/$id",
    (identity) => {
      const result: ManagedCreateResult = {
        outcome: "created",
        entity: "node",
        row: nodeRow(identity),
      };

      expect(() => {
        assertManagedCreateResultMatchesPlan(NODE_PLAN, result);
      }).toThrow(CompilerInvariantError);
    },
  );

  it.each([
    { graphId: "foreign-graph", kind: "knows", id: "expected-edge" },
    { graphId: "expected-graph", kind: "likes", id: "expected-edge" },
    { graphId: "expected-graph", kind: "knows", id: "foreign-edge" },
  ])(
    "refuses an edge row at a foreign identity: $graphId/$kind/$id",
    (identity) => {
      const result: ManagedCreateResult = {
        outcome: "created",
        entity: "edge",
        row: edgeRow(identity),
      };

      expect(() => {
        assertManagedCreateResultMatchesPlan(EDGE_PLAN, result);
      }).toThrow(CompilerInvariantError);
    },
  );

  it("accepts a created row at the submitted identity", () => {
    expect(() => {
      assertManagedCreateResultMatchesPlan(NODE_PLAN, {
        outcome: "created",
        entity: "node",
        row: nodeRow({
          graphId: NODE_PLAN.params.graphId,
          kind: NODE_PLAN.params.kind,
          id: NODE_PLAN.params.id,
        }),
      });
    }).not.toThrow();
  });
});
