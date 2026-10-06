import { describe, expect, it } from "vitest";

import {
  assertFencedSnapshotIsFresh,
  assertGraphCommandConvergenceIsolation,
  assertGraphCommandExecutionContext,
  executeAuthoritativeGraphCommand,
  graphCommandCoordinationIsolation,
  graphCommandExecutionContext,
  mintGraphCommandCoordination,
  observesPostFenceCommits,
  readGraphWriteFenceAcquisition,
} from "../src/backend/command-contract";
import type {
  EdgeConvergeCreateCommand,
  EdgeRow,
  GraphCommand,
  GraphCommandPort,
  GraphWriteFenceAcquisition,
  NodeCreateCommand,
  NodeRow,
} from "../src/backend/types";

const TIMESTAMP = "2026-08-24T00:00:00.000Z";

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

function nodeRow(id: string): NodeRow {
  return {
    graph_id: "graph",
    kind: "Person",
    id,
    props: {},
    version: 1,
    valid_from: undefined,
    valid_to: undefined,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    deleted_at: undefined,
  };
}

const EDGE_CONVERGE_COMMAND: EdgeConvergeCreateCommand = {
  kind: "edge.converge-create",
  plan: {
    entity: "edge",
    params: {
      graphId: "graph",
      kind: "knows",
      id: "candidate",
      fromKind: "Person",
      fromId: "from",
      toKind: "Person",
      toId: "to",
      props: {},
      matchIdentity: { name: "knows-pair", key: "expected-key" },
    },
  },
  match: {
    kind: "durable",
    identity: { name: "knows-pair", key: "expected-key" },
  },
};

function edgeRow(matchIdentityKey: string): EdgeRow {
  return {
    graph_id: "graph",
    kind: "knows",
    id: "winner",
    from_kind: "Person",
    from_id: "from",
    to_kind: "Person",
    to_id: "to",
    props: {},
    match_identity_name: "knows-pair",
    match_identity_key: matchIdentityKey,
    valid_from: undefined,
    valid_to: undefined,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    deleted_at: undefined,
  };
}

describe("authoritative graph command contract", () => {
  it.each([
    "read_committed",
    "serializable",
    "repeatable_read",
    "unknown",
  ] as const)(
    "reads observed %s isolation only for the owning graph and session",
    (isolation) => {
      const port: GraphCommandPort = {
        session: "transaction",
        execute: () => Promise.resolve(RESULT),
      };
      const otherPort: GraphCommandPort = {
        session: "transaction",
        execute: () => Promise.resolve(RESULT),
      };
      const coordination = mintGraphCommandCoordination(port, "graph", {
        isolation,
        fenceRow: "none",
      });
      expect(
        graphCommandCoordinationIsolation(port, "graph", coordination),
      ).toBe(isolation);
      expect(
        graphCommandCoordinationIsolation(port, "other", coordination),
      ).toBe("unknown");
      expect(
        graphCommandCoordinationIsolation(otherPort, "graph", coordination),
      ).toBe("unknown");
    },
  );

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

  it("validates command/result correlation inside the execution helper", async () => {
    const port: GraphCommandPort = {
      session: "root",
      execute: () =>
        Promise.resolve({
          outcome: "rejected" as const,
          entity: "edge" as const,
          reason: "unknown" as const,
        }),
    };

    await expect(
      executeAuthoritativeGraphCommand(port, COMMAND),
    ).rejects.toThrow("submitted command entity");
  });

  it("rejects a created row with a foreign identity inside the execution helper", async () => {
    const port: GraphCommandPort = {
      session: "root",
      execute: () =>
        Promise.resolve({
          outcome: "created" as const,
          entity: "node" as const,
          row: nodeRow("foreign-node"),
        }),
    };

    await expect(
      executeAuthoritativeGraphCommand(port, COMMAND),
    ).rejects.toThrow("submitted command identity");
  });

  it("rejects a found row with a foreign durable identity inside the execution helper", async () => {
    const port: GraphCommandPort = {
      session: "root",
      execute: () =>
        Promise.resolve({
          outcome: "found" as const,
          entity: "edge" as const,
          row: edgeRow("foreign-key"),
        }),
    };

    await expect(
      executeAuthoritativeGraphCommand(port, EDGE_CONVERGE_COMMAND),
    ).rejects.toThrow("submitted edge identity");
  });

  it("accepts the context constructed for a root command", () => {
    const context = graphCommandExecutionContext("root");

    expect(() => {
      assertGraphCommandExecutionContext(context);
    }).not.toThrow();
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
    const coordination = mintGraphCommandCoordination(portA, "other-graph", {
      isolation: "read_committed",
      fenceRow: "none",
    });

    expect(() =>
      executeAuthoritativeGraphCommand(portA, COMMAND, coordination),
    ).toThrow("does not belong");
    expect(() =>
      executeAuthoritativeGraphCommand(portB, COMMAND, coordination),
    ).toThrow("does not belong");
  });

  it("refuses transaction coordination on a root context", () => {
    const port: GraphCommandPort = {
      session: "transaction",
      execute: () => Promise.resolve(RESULT),
    };
    const coordination = mintGraphCommandCoordination(port, "graph", {
      isolation: "read_committed",
      fenceRow: "none",
    });

    expect(() => graphCommandExecutionContext("root", coordination)).toThrow(
      "root command",
    );
  });
});

/**
 * Every acquisition the per-graph write fence can report, and whether a
 * session that acquired it that way reads what the fence's previous holders
 * committed. A lock cannot refresh a snapshot taken before the wait, so a
 * snapshot isolation is trusted only when its acquisition advanced the
 * graph's fence row — the write a stale session fails on.
 */
const FENCE_ACQUISITIONS: readonly Readonly<{
  acquisition: GraphWriteFenceAcquisition;
  observesWinner: boolean;
}>[] = [
  {
    acquisition: { isolation: "read_committed", fenceRow: "advanced" },
    observesWinner: true,
  },
  {
    acquisition: { isolation: "read_committed", fenceRow: "none" },
    observesWinner: true,
  },
  {
    acquisition: { isolation: "repeatable_read", fenceRow: "advanced" },
    observesWinner: true,
  },
  {
    acquisition: { isolation: "repeatable_read", fenceRow: "none" },
    observesWinner: false,
  },
  {
    acquisition: { isolation: "serializable", fenceRow: "advanced" },
    observesWinner: true,
  },
  {
    acquisition: { isolation: "serializable", fenceRow: "none" },
    observesWinner: false,
  },
  {
    acquisition: { isolation: "unknown", fenceRow: "advanced" },
    observesWinner: false,
  },
  {
    acquisition: { isolation: "unknown", fenceRow: "none" },
    observesWinner: false,
  },
];

describe("a fenced decision observes the fence's previous holders", () => {
  const port: GraphCommandPort = {
    session: "transaction",
    execute: () => Promise.resolve(RESULT),
  };
  const refusal = { code: "LOCK_ONLY_REQUIRES_FRESH_SNAPSHOT", subject: "It" };

  // The two consumers read the SAME verdict off the coordination the
  // acquisition minted: a lock-only read and match-key convergence.
  it.each(FENCE_ACQUISITIONS.filter((entry) => entry.observesWinner))(
    "$acquisition.isolation with fence row $acquisition.fenceRow is trusted",
    ({ acquisition }) => {
      expect(observesPostFenceCommits(acquisition)).toBe(true);
      const coordination = mintGraphCommandCoordination(
        port,
        "graph",
        acquisition,
      );
      expect(() => {
        assertFencedSnapshotIsFresh(port, "graph", coordination, refusal);
      }).not.toThrow();
      expect(() => {
        assertGraphCommandConvergenceIsolation(port, coordination);
      }).not.toThrow();
    },
  );

  it.each(FENCE_ACQUISITIONS.filter((entry) => !entry.observesWinner))(
    "$acquisition.isolation with fence row $acquisition.fenceRow is refused",
    ({ acquisition }) => {
      expect(observesPostFenceCommits(acquisition)).toBe(false);
      const coordination = mintGraphCommandCoordination(
        port,
        "graph",
        acquisition,
      );
      expect(() => {
        assertFencedSnapshotIsFresh(port, "graph", coordination, refusal);
      }).toThrow(
        expect.objectContaining({
          details: expect.objectContaining({
            code: refusal.code,
            ...acquisition,
          }) as unknown,
        }),
      );
      expect(() => {
        assertGraphCommandConvergenceIsolation(port, coordination);
      }).toThrow(
        expect.objectContaining({
          details: expect.objectContaining({
            code: "MATCH_KEY_CONVERGENCE_REQUIRES_FRESH_SNAPSHOT",
            ...acquisition,
          }) as unknown,
        }),
      );
    },
  );

  it("needs no evidence where no keyed fence exists to wait on", () => {
    expect(() => {
      assertFencedSnapshotIsFresh(port, "graph", undefined, refusal);
    }).not.toThrow();
  });

  it("refuses coordination earned for another graph as unobserved", () => {
    const coordination = mintGraphCommandCoordination(port, "other-graph", {
      isolation: "read_committed",
      fenceRow: "advanced",
    });
    expect(() => {
      assertFencedSnapshotIsFresh(port, "graph", coordination, refusal);
    }).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({
          isolation: "unknown",
          fenceRow: "none",
        }) as unknown,
      }),
    );
  });
});

describe("readGraphWriteFenceAcquisition", () => {
  it.each([
    [
      { transaction_isolation: "read committed", generation: "3" },
      { isolation: "read_committed", fenceRow: "advanced" },
    ],
    [
      { transaction_isolation: "serializable", generation: 1 },
      { isolation: "serializable", fenceRow: "advanced" },
    ],
    [
      { transaction_isolation: "repeatable read" },
      { isolation: "repeatable_read", fenceRow: "none" },
    ],
    [{ generation: 7 }, { isolation: "unknown", fenceRow: "advanced" }],
    // eslint-disable-next-line unicorn/no-null -- a driver reports an absent column value as SQL NULL
    [{ generation: null }, { isolation: "unknown", fenceRow: "none" }],
    [undefined, { isolation: "unknown", fenceRow: "none" }],
  ] as const)("reads %o as %o", (row, expected) => {
    expect(readGraphWriteFenceAcquisition(row)).toEqual(expected);
  });
});
