import { describe, expect, it } from "vitest";

import {
  assertGraphCommandExecutionContext,
  executeAuthoritativeGraphCommand,
  graphCommandExecutionContext,
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
  it.each([
    ["root", "single-statement"],
    ["transaction", "transaction"],
  ] as const)(
    "binds %s commands to the matching atomicity boundary",
    (session, atomicity) => {
      expect(graphCommandExecutionContext(session)).toEqual({
        session,
        atomicity,
        authority: "authoritative",
        resultCache: "bypass",
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
        atomicity: "transaction",
        authority: "authoritative",
        resultCache: "bypass",
        coordination: "none",
      },
    ]);
  });

  it("rejects a context that claims the wrong atomicity boundary", () => {
    expect(() => {
      assertGraphCommandExecutionContext({
        session: "root",
        atomicity: "transaction",
        authority: "authoritative",
        resultCache: "bypass",
      });
    }).toThrow();
  });

  it("rejects forged graph-write coordination evidence", () => {
    expect(() => {
      assertGraphCommandExecutionContext({
        session: "transaction",
        atomicity: "transaction",
        authority: "authoritative",
        resultCache: "bypass",
        coordination: {},
      });
    }).toThrow();
  });
});
