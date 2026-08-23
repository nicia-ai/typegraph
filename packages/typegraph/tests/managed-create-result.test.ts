import { describe, expect, it } from "vitest";

import { assertCommandResultMatchesCommand } from "../src/backend/command";
import type {
  EdgeConvergeCreateCommand,
  EdgeConvergeCreateCommandResult,
  EdgeCreateCommand,
  EdgeCreateCommandResult,
  EdgeRow,
  NodeCreateCommand,
  NodeCreateCommandResult,
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

const NODE_COMMAND: NodeCreateCommand = {
  kind: "node.create",
  plan: {
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
  },
};

const EDGE_COMMAND: EdgeCreateCommand = {
  kind: "edge.create",
  plan: {
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
  },
};

const EDGE_CONVERGE_COMMAND: EdgeConvergeCreateCommand = {
  kind: "edge.converge-create",
  plan: EDGE_COMMAND.plan,
  match: {
    kind: "dynamic",
    matchOn: ["label"],
    props: { label: "friend" },
  },
};

describe("command result correlation", () => {
  it.each([
    { graphId: "foreign-graph", kind: "Person", id: "expected-node" },
    { graphId: "expected-graph", kind: "Company", id: "expected-node" },
    { graphId: "expected-graph", kind: "Person", id: "foreign-node" },
  ])(
    "refuses a node row at a foreign identity: $graphId/$kind/$id",
    (identity) => {
      const result: NodeCreateCommandResult = {
        outcome: "created",
        entity: "node",
        row: nodeRow(identity),
      };

      expect(() => {
        assertCommandResultMatchesCommand(NODE_COMMAND, result);
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
      const result: EdgeCreateCommandResult = {
        outcome: "created",
        entity: "edge",
        row: edgeRow(identity),
      };

      expect(() => {
        assertCommandResultMatchesCommand(EDGE_COMMAND, result);
      }).toThrow(CompilerInvariantError);
    },
  );

  it("accepts a created row at the submitted identity", () => {
    expect(() => {
      assertCommandResultMatchesCommand(NODE_COMMAND, {
        outcome: "created",
        entity: "node",
        row: nodeRow({
          graphId: NODE_COMMAND.plan.params.graphId,
          kind: NODE_COMMAND.plan.params.kind,
          id: NODE_COMMAND.plan.params.id,
        }),
      });
    }).not.toThrow();
  });

  it("accepts a found convergence row with a different generated id", () => {
    const result: EdgeConvergeCreateCommandResult = {
      outcome: "found",
      entity: "edge",
      row: edgeRow({
        graphId: EDGE_CONVERGE_COMMAND.plan.params.graphId,
        kind: EDGE_CONVERGE_COMMAND.plan.params.kind,
        id: "winner-generated-id",
      }),
    };

    expect(() => {
      assertCommandResultMatchesCommand(EDGE_CONVERGE_COMMAND, result);
    }).not.toThrow();
  });

  it("rejects a found convergence row with different endpoints", () => {
    const result: EdgeConvergeCreateCommandResult = {
      outcome: "found",
      entity: "edge",
      row: {
        ...edgeRow({
          graphId: EDGE_CONVERGE_COMMAND.plan.params.graphId,
          kind: EDGE_CONVERGE_COMMAND.plan.params.kind,
          id: "winner-generated-id",
        }),
        to_id: "other",
      },
    };

    expect(() => {
      assertCommandResultMatchesCommand(EDGE_CONVERGE_COMMAND, result);
    }).toThrow(CompilerInvariantError);
  });

  it("rejects a found result for a non-convergence edge command", () => {
    const result: EdgeConvergeCreateCommandResult = {
      outcome: "found",
      entity: "edge",
      row: edgeRow({
        graphId: EDGE_COMMAND.plan.params.graphId,
        kind: EDGE_COMMAND.plan.params.kind,
        id: EDGE_COMMAND.plan.params.id,
      }),
    };

    expect(() => {
      assertCommandResultMatchesCommand(EDGE_COMMAND, result);
    }).toThrow(CompilerInvariantError);
  });
});
