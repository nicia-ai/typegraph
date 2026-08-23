import { describe, expect, it } from "vitest";

import {
  assertGraphCommandExecutionContext,
  executeAuthoritativeGraphCommand,
  graphCommandExecutionContext,
  mintGraphCommandCoordination,
} from "../src/backend/command-contract";
import type {
  GraphCommand,
  GraphCommandPort,
  NodeCreateCommand,
} from "../src/backend/types";

const COMMAND: NodeCreateCommand = {
  kind: "node.create",
  plan: {
    entity: "node",
    params: {
      graphId: "graph",
      kind: "Person",
      id: "person",
      props: {},
    },
    idGenerated: true,
    mode: { kind: "ordinary" },
    claims: [],
    projections: [],
  },
};

const RESULT = {
  outcome: "rejected" as const,
  entity: "node" as const,
  reason: "unknown" as const,
};

describe("authoritative graph command contract", () => {
  it.each(["root", "transaction"] as const)(
    "binds %s commands to the matching session boundary",
    (session) => {
      expect(graphCommandExecutionContext(session)).toEqual({
        session,
        coordination: "none",
      });
    },
  );

  it("passes the explicit context to the command port", async () => {
    const contexts: unknown[] = [];
    const port: GraphCommandPort = {
      session: "transaction",
      execute(command: GraphCommand, context) {
        expect(command).toBe(COMMAND);
        contexts.push(context);
        return Promise.resolve(RESULT);
      },
    };

    await executeAuthoritativeGraphCommand(port, COMMAND);

    expect(contexts).toEqual([
      {
        session: "transaction",
        coordination: "none",
      },
    ]);
  });

  it("rejects forged graph-write coordination evidence", () => {
    expect(() => {
      assertGraphCommandExecutionContext({
        session: "transaction",
        coordination: {},
      });
    }).toThrow();
  });

  it.each([undefined, false, {}])(
    "rejects an invalid context value",
    (context) => {
      expect(() => {
        assertGraphCommandExecutionContext(context);
      }).toThrow();
    },
  );

  it("refuses coordination minted for another port or graph", () => {
    const portA: GraphCommandPort = {
      session: "transaction",
      execute: () => Promise.resolve(RESULT),
    };
    const portB: GraphCommandPort = {
      session: "transaction",
      execute: () => Promise.resolve(RESULT),
    };
    const coordination = mintGraphCommandCoordination(portA, "other-graph");

    expect(() =>
      executeAuthoritativeGraphCommand(portA, COMMAND, coordination),
    ).toThrow("does not belong");
    expect(() =>
      executeAuthoritativeGraphCommand(portB, COMMAND, coordination),
    ).toThrow("does not belong");
  });
});
