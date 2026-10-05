/**
 * Durable-branch operations: the public orchestrators over the optional
 * `DurableWorkingCopyStrategy.operations` capability.
 *
 * A recording in-memory strategy exercises the complete public contract —
 * unsupported with zero mutation, exact replay, digest conflict, stable scan
 * pagination, idempotent delivery marking, undelivered detection, and the
 * destroy/archive fence — without a database. A real PostgreSQL strategy test
 * proving mutation-plus-evidence transaction atomicity remains an explicit
 * integration gate for a first-party durable host.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../../src";
import {
  computeDurableOperationDigest,
  destroyDurableBranch,
  durableBranchHasUndeliveredEvidence,
  type DurableBranchOperation,
  type DurableBranchOperationEvidence,
  type DurableBranchOperationRequest,
  type DurableBranchOrigin,
  DurableEvidenceUndeliveredError,
  DurableOperationConflictError,
  DurableOperationError,
  DurableOperationEvidenceError,
  type DurableOperationOutcome,
  DurableOperationRequestError,
  DurableOperationUnsupportedError,
  type DurableStoreDescriptor,
  type DurableWorkingCopyStrategy,
  getDurableOperation,
  isErr,
  isOk,
  markDurableOperationDelivered,
  operateDurableBranch,
  scanDurableOperations,
} from "../../src/graph-merge";
import { asBaseVersion, asBranchId } from "../../src/graph-merge/types";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "durable-operation-unit",
  nodes: { Person: { type: Person } },
  edges: {},
});
type G = typeof graph;

const FIXED_ORIGIN: DurableBranchOrigin = {
  allocationId: "allocation-1",
  graphId: graph.id,
  definitionHash: "definition-hash",
  branchId: asBranchId("branch-1"),
  base: asBaseVersion("base-1"),
  schemaAnchor: { version: 1, hash: "schema-hash" },
  forkRevision: undefined,
};

const DESCRIPTOR: DurableStoreDescriptor = { locator: "working-copy-1" };

function sameOrigin(a: DurableBranchOrigin, b: DurableBranchOrigin): boolean {
  const anchor = (value: DurableBranchOrigin["schemaAnchor"]): string =>
    value === undefined ? "absent" : `${value.version}:${value.hash}`;
  return (
    a.allocationId === b.allocationId &&
    a.graphId === b.graphId &&
    a.definitionHash === b.definitionHash &&
    a.branchId === b.branchId &&
    a.base === b.base &&
    a.forkRevision === b.forkRevision &&
    anchor(a.schemaAnchor) === anchor(b.schemaAnchor)
  );
}

type RecordingHost = Readonly<{
  strategy: DurableWorkingCopyStrategy<G, DurableStoreDescriptor>;
  /** Opaque mutations the host actually applied, in order. */
  appliedMutations: () => readonly unknown[];
  /** Overrides the origin the host attests for the allocation. */
  attest: (origin: DurableBranchOrigin) => void;
  evidence: (key: string) => DurableBranchOperationEvidence | undefined;
}>;

/**
 * Builds a recording strategy whose `operations` member behaves as the public
 * contract requires. The host is deliberately in-memory: it proves the
 * TypeGraph-owned orchestration, not the database guarantee.
 */
function createRecordingHost(): RecordingHost {
  const byKey = new Map<string, DurableBranchOperationEvidence>();
  const order: string[] = [];
  const applied: unknown[] = [];
  let storedOrigin: DurableBranchOrigin = FIXED_ORIGIN;
  let queue: Promise<unknown> = Promise.resolve();

  const assertOrigin = (expectedOrigin: DurableBranchOrigin): void => {
    if (!sameOrigin(storedOrigin, expectedOrigin)) {
      throw new DurableOperationError(
        "host refused: descriptor origin disagrees with the sealed origin",
      );
    }
  };

  const evidenceFor = (
    request: DurableBranchOperation,
  ): DurableBranchOperationEvidence => ({
    idempotencyKey: request.idempotencyKey,
    operationDigest: request.operationDigest,
    metadata: request.metadata,
    mutation: request.mutation,
    before: { base: asBaseVersion("coordinate-before") },
    after: { base: asBaseVersion("coordinate-after") },
    delivered: false,
  });

  const strategy: DurableWorkingCopyStrategy<G, DurableStoreDescriptor> = {
    type: "recording-durable-operation-host",
    version: 1,
    create: () => Promise.reject(new Error("not used")),
    seal: () => Promise.reject(new Error("not used")),
    abort: () => Promise.reject(new Error("not used")),
    reopen: () => Promise.reject(new Error("not used")),
    destroy: async (_descriptor, expectedOrigin) => {
      assertOrigin(expectedOrigin);
      const undelivered = [...byKey.values()].some(
        (operation) => !operation.delivered,
      );
      if (undelivered) {
        throw new DurableEvidenceUndeliveredError(
          "refusing to destroy: undelivered operation evidence remains",
        );
      }
    },
    operations: {
      operate: async ({ expectedOrigin, request }) => {
        assertOrigin(expectedOrigin);
        return new Promise((resolve, reject) => {
          queue = queue.then(async () => {
            const existing = byKey.get(request.idempotencyKey);
            if (existing !== undefined) {
              if (existing.operationDigest !== request.operationDigest) {
                reject(
                  new DurableOperationConflictError(
                    `idempotency key "${request.idempotencyKey}" was reused with a different digest`,
                  ),
                );
                return;
              }
              resolve({ outcome: "replayed", evidence: existing });
              return;
            }
            applied.push(request.mutation);
            const evidence = evidenceFor(request);
            byKey.set(request.idempotencyKey, evidence);
            order.push(request.idempotencyKey);
            resolve({ outcome: "applied", evidence });
          });
        });
      },
      get: async ({ expectedOrigin, idempotencyKey }) => {
        assertOrigin(expectedOrigin);
        return byKey.get(idempotencyKey);
      },
      scan: async ({ expectedOrigin, after, limit }) => {
        assertOrigin(expectedOrigin);
        const start = after === undefined ? 0 : Number(after) + 1;
        const page = order.slice(start, start + limit);
        const operations = page.map((key) => {
          const evidence = byKey.get(key);
          if (evidence === undefined)
            throw new Error(`missing evidence ${key}`);
          return evidence;
        });
        const lastIndex = start + page.length - 1;
        return {
          operations,
          cursor: page.length === 0 ? after : String(lastIndex),
          hasMore: lastIndex + 1 < order.length,
        };
      },
      markDelivered: async ({ expectedOrigin, idempotencyKey }) => {
        assertOrigin(expectedOrigin);
        const existing = byKey.get(idempotencyKey);
        if (existing === undefined) return;
        if (existing.delivered) return existing;
        const delivered = { ...existing, delivered: true };
        byKey.set(idempotencyKey, delivered);
        return delivered;
      },
      hasUndelivered: async ({ expectedOrigin }) => {
        assertOrigin(expectedOrigin);
        return [...byKey.values()].some((operation) => !operation.delivered);
      },
    },
  };

  return {
    strategy,
    appliedMutations: () => [...applied],
    attest: (origin) => {
      storedOrigin = origin;
    },
    evidence: (key) => byKey.get(key),
  };
}

function request(
  idempotencyKey: string,
  overrides: Partial<DurableBranchOperationRequest> = {},
): DurableBranchOperationRequest {
  return {
    idempotencyKey,
    metadata: { actor: "host", note: "op" },
    mutation: { kind: "createPerson", name: "Alice" },
    ...overrides,
  };
}

async function storedEvidence(
  overrides: Partial<DurableBranchOperationEvidence> = {},
): Promise<DurableBranchOperationEvidence> {
  const base = {
    idempotencyKey: "op-1",
    metadata: { actor: "host" },
    mutation: { kind: "createPerson", name: "Alice" },
    before: { base: asBaseVersion("coordinate-before") },
    after: { base: asBaseVersion("coordinate-after") },
    delivered: false,
  };
  return {
    ...base,
    operationDigest: await computeDurableOperationDigest(base),
    ...overrides,
  };
}

const descriptor = {
  allocationId: FIXED_ORIGIN.allocationId,
  kind: "recording-durable-operation-host",
  version: 1,
  graphId: graph.id,
  definitionHash: FIXED_ORIGIN.definitionHash,
  branchId: FIXED_ORIGIN.branchId,
  base: FIXED_ORIGIN.base,
  store: DESCRIPTOR,
  schemaAnchor: FIXED_ORIGIN.schemaAnchor,
};

describe("durable branch operations", () => {
  it("applies the mutation once and returns immutable evidence with coordinates", async () => {
    const host = createRecordingHost();
    const result = await operateDurableBranch(
      descriptor,
      host.strategy,
      request("op-1"),
    );

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.outcome).toBe("applied");
    if (result.data.outcome === "unsupported") return;
    expect(result.data.evidence.idempotencyKey).toBe("op-1");
    expect(result.data.evidence.metadata).toEqual({
      actor: "host",
      note: "op",
    });
    expect(result.data.evidence.before.base).toBe("coordinate-before");
    expect(result.data.evidence.after.base).toBe("coordinate-after");
    expect(host.appliedMutations()).toHaveLength(1);
  });

  it("replays the exact previously committed evidence without applying again", async () => {
    const host = createRecordingHost();
    const first = await operateDurableBranch(
      descriptor,
      host.strategy,
      request("op-1"),
    );
    const second = await operateDurableBranch(
      descriptor,
      host.strategy,
      request("op-1"),
    );

    expect(isOk(first) && first.data.outcome === "applied").toBe(true);
    expect(isOk(second) && second.data.outcome === "replayed").toBe(true);
    if (
      isOk(first) &&
      isOk(second) &&
      first.data.outcome !== "unsupported" &&
      second.data.outcome !== "unsupported"
    ) {
      expect(second.data.evidence).toEqual(first.data.evidence);
    }
    expect(host.appliedMutations()).toHaveLength(1);
  });

  it("accepts delivered evidence only when replaying a committed operation", async () => {
    const host = createRecordingHost();
    const first = await operateDurableBranch(
      descriptor,
      host.strategy,
      request("op-1"),
    );
    const delivered = await markDurableOperationDelivered(
      descriptor,
      host.strategy,
      "op-1",
    );
    const replay = await operateDurableBranch(
      descriptor,
      host.strategy,
      request("op-1"),
    );

    expect(isOk(first) && first.data.outcome === "applied").toBe(true);
    expect(isOk(delivered) && delivered.data?.delivered).toBe(true);
    expect(
      isOk(replay) &&
        replay.data.outcome === "replayed" &&
        replay.data.evidence.delivered,
    ).toBe(true);
    expect(host.appliedMutations()).toHaveLength(1);
  });

  it("refuses a reused idempotency key with a different digest and mutates nothing", async () => {
    const host = createRecordingHost();
    await operateDurableBranch(descriptor, host.strategy, request("op-1"));

    const conflict = await operateDurableBranch(
      descriptor,
      host.strategy,
      request("op-1", { metadata: { actor: "host", note: "different" } }),
    );

    expect(isErr(conflict)).toBe(true);
    if (isErr(conflict)) {
      expect(conflict.error).toBeInstanceOf(DurableOperationConflictError);
      expect(conflict.error.code).toBe("GRAPH_MERGE_OPERATION_CONFLICT");
    }
    expect(host.appliedMutations()).toHaveLength(1);
    // The originally committed evidence survives untouched.
    expect(host.evidence("op-1")?.metadata).toEqual({
      actor: "host",
      note: "op",
    });
  });

  it("returns unsupported before any host call when the strategy has no operations capability", async () => {
    const host = createRecordingHost();
    const withoutOperations: DurableWorkingCopyStrategy<
      G,
      DurableStoreDescriptor
    > = {
      type: host.strategy.type,
      version: host.strategy.version,
      create: host.strategy.create,
      seal: host.strategy.seal,
      abort: host.strategy.abort,
      reopen: host.strategy.reopen,
      destroy: host.strategy.destroy,
    };

    const result = await operateDurableBranch(
      descriptor,
      withoutOperations,
      request("op-1"),
    );

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.data.outcome).toBe("unsupported");
      if (result.data.outcome === "unsupported") {
        expect(result.data.dimensions).toContain("atomicMutation");
      }
    }
    expect(host.appliedMutations()).toHaveLength(0);
  });

  it("refuses non-JSON metadata before touching the host", async () => {
    const host = createRecordingHost();
    const unsafe = request("op-1", {
      metadata: {
        createdAt: new Date(),
      } as unknown as DurableBranchOperationRequest["metadata"],
    });

    const result = await operateDurableBranch(
      descriptor,
      host.strategy,
      unsafe,
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(DurableOperationRequestError);
      expect(result.error.category).toBe("user");
    }
    expect(host.appliedMutations()).toHaveLength(0);
  });

  it("refuses a non-empty idempotency key requirement before touching the host", async () => {
    const host = createRecordingHost();
    const result = await operateDurableBranch(
      descriptor,
      host.strategy,
      request(""),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(DurableOperationRequestError);
      expect(result.error.category).toBe("user");
    }
    expect(host.appliedMutations()).toHaveLength(0);
  });

  it("returns a request error for a non-object operation request", async () => {
    const host = createRecordingHost();
    const result = await operateDurableBranch(
      descriptor,
      host.strategy,
      null as unknown as DurableBranchOperationRequest,
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(DurableOperationRequestError);
      expect(result.error.category).toBe("user");
    }
    expect(host.appliedMutations()).toHaveLength(0);
  });

  it("refuses a malformed descriptor envelope and a strategy that does not own it", async () => {
    const host = createRecordingHost();
    const wrongKind = await operateDurableBranch(
      { ...descriptor, kind: "someone-else" },
      host.strategy,
      request("op-1"),
    );
    expect(isErr(wrongKind)).toBe(true);
    if (isErr(wrongKind)) {
      expect(wrongKind.error).toBeInstanceOf(DurableOperationRequestError);
      expect(wrongKind.error.category).toBe("user");
      expect(wrongKind.error.message).toContain("descriptor");
    }

    const malformed = await operateDurableBranch(
      { ...descriptor, branchId: asBranchId("") },
      host.strategy,
      request("op-1"),
    );
    expect(isErr(malformed)).toBe(true);
    expect(host.appliedMutations()).toHaveLength(0);
  });

  it("refuses a stale descriptor origin before applying any mutation", async () => {
    const host = createRecordingHost();
    const stale = { ...descriptor, base: asBaseVersion("tampered-base") };

    const result = await operateDurableBranch(
      stale,
      host.strategy,
      request("op-1"),
    );

    expect(isErr(result)).toBe(true);
    expect(host.appliedMutations()).toHaveLength(0);
    expect(host.evidence("op-1")).toBeUndefined();
  });

  it("scans evidence in a stable order with a cursor and limit contract", async () => {
    const host = createRecordingHost();
    for (const key of ["op-1", "op-2", "op-3", "op-4", "op-5"]) {
      await operateDurableBranch(descriptor, host.strategy, request(key));
    }

    const first = await scanDurableOperations(descriptor, host.strategy, {
      limit: 2,
    });
    expect(isOk(first)).toBe(true);
    if (!isOk(first)) return;
    expect(
      first.data.operations.map((operation) => operation.idempotencyKey),
    ).toEqual(["op-1", "op-2"]);
    expect(first.data.cursor).toBe("1");

    const second = await scanDurableOperations(descriptor, host.strategy, {
      after: first.data.cursor,
      limit: 2,
    });
    expect(isOk(second)).toBe(true);
    if (!isOk(second)) return;
    expect(
      second.data.operations.map((operation) => operation.idempotencyKey),
    ).toEqual(["op-3", "op-4"]);

    const last = await scanDurableOperations(descriptor, host.strategy, {
      after: second.data.cursor,
      limit: 2,
    });
    expect(isOk(last)).toBe(true);
    if (!isOk(last)) return;
    expect(
      last.data.operations.map((operation) => operation.idempotencyKey),
    ).toEqual(["op-5"]);
    expect(last.data.cursor).toBe("4");
    expect(last.data.hasMore).toBe(false);

    await operateDurableBranch(descriptor, host.strategy, request("op-6"));
    const resumed = await scanDurableOperations(descriptor, host.strategy, {
      after: last.data.cursor,
      limit: 2,
    });
    expect(isOk(resumed)).toBe(true);
    if (!isOk(resumed)) return;
    expect(
      resumed.data.operations.map((operation) => operation.idempotencyKey),
    ).toEqual(["op-6"]);
  });

  it("rejects an out-of-range scan limit before touching the host", async () => {
    const host = createRecordingHost();
    const result = await scanDurableOperations(descriptor, host.strategy, {
      limit: 100_000,
    });
    expect(isErr(result)).toBe(true);
  });

  it("marks delivery idempotently and reports undelivered evidence precisely", async () => {
    const host = createRecordingHost();
    await operateDurableBranch(descriptor, host.strategy, request("op-1"));
    await operateDurableBranch(descriptor, host.strategy, request("op-2"));

    const beforeAny = await durableBranchHasUndeliveredEvidence(
      descriptor,
      host.strategy,
    );
    expect(isOk(beforeAny) && beforeAny.data).toBe(true);

    const firstMark = await markDurableOperationDelivered(
      descriptor,
      host.strategy,
      "op-1",
    );
    const secondMark = await markDurableOperationDelivered(
      descriptor,
      host.strategy,
      "op-1",
    );
    expect(isOk(firstMark) && firstMark.data?.delivered === true).toBe(true);
    expect(isOk(secondMark) && secondMark.data?.delivered === true).toBe(true);
    if (isOk(firstMark) && isOk(secondMark)) {
      expect(secondMark.data).toEqual(firstMark.data);
    }

    const stillUndelivered = await durableBranchHasUndeliveredEvidence(
      descriptor,
      host.strategy,
    );
    expect(isOk(stillUndelivered) && stillUndelivered.data).toBe(true);

    await markDurableOperationDelivered(descriptor, host.strategy, "op-2");
    const noneLeft = await durableBranchHasUndeliveredEvidence(
      descriptor,
      host.strategy,
    );
    expect(isOk(noneLeft) && !noneLeft.data).toBe(true);

    const missing = await getDurableOperation(
      descriptor,
      host.strategy,
      "op-missing",
    );
    expect(isOk(missing) && missing.data === undefined).toBe(true);

    const missingMark = await markDurableOperationDelivered(
      descriptor,
      host.strategy,
      "op-missing",
    );
    expect(isOk(missingMark) && missingMark.data === undefined).toBe(true);
  });

  it("refuses evidence access with a typed unsupported error when the capability is absent", async () => {
    const host = createRecordingHost();
    const withoutOperations: DurableWorkingCopyStrategy<
      G,
      DurableStoreDescriptor
    > = {
      type: host.strategy.type,
      version: host.strategy.version,
      create: host.strategy.create,
      seal: host.strategy.seal,
      abort: host.strategy.abort,
      reopen: host.strategy.reopen,
      destroy: host.strategy.destroy,
    };

    const result = await getDurableOperation(
      descriptor,
      withoutOperations,
      "op-1",
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(DurableOperationUnsupportedError);
      expect(result.error.code).toBe("GRAPH_MERGE_OPERATION_UNSUPPORTED");
      expect(result.error.category).toBe("user");
    }
  });

  it("fences destroy on undelivered evidence and preserves the typed refusal", async () => {
    const host = createRecordingHost();
    await operateDurableBranch(descriptor, host.strategy, request("op-1"));

    const refused = await destroyDurableBranch(descriptor, host.strategy);
    expect(isErr(refused)).toBe(true);
    if (isErr(refused)) {
      expect(refused.error).toBeInstanceOf(DurableEvidenceUndeliveredError);
      expect(refused.error.code).toBe("GRAPH_MERGE_OPERATION_UNDELIVERED");
    }

    await markDurableOperationDelivered(descriptor, host.strategy, "op-1");
    const destroyed = await destroyDurableBranch(descriptor, host.strategy);
    expect(isOk(destroyed)).toBe(true);
  });

  it("serializes concurrent same-key operations to one applied mutation and one shared evidence", async () => {
    const host = createRecordingHost();
    const [left, right] = await Promise.all([
      operateDurableBranch(descriptor, host.strategy, request("op-1")),
      operateDurableBranch(descriptor, host.strategy, request("op-1")),
    ]);

    expect(isOk(left) && isOk(right)).toBe(true);
    expect(host.appliedMutations()).toHaveLength(1);
    if (
      isOk(left) &&
      isOk(right) &&
      left.data.outcome !== "unsupported" &&
      right.data.outcome !== "unsupported"
    ) {
      expect(left.data.evidence).toEqual(right.data.evidence);
      const outcomes = [left.data.outcome, right.data.outcome].sort();
      expect(outcomes).toEqual(["applied", "replayed"]);
    }
  });

  it("refuses when the host returns evidence inconsistent with the request", async () => {
    const host = createRecordingHost();
    const lyingStrategy: DurableWorkingCopyStrategy<G, DurableStoreDescriptor> =
      {
        ...host.strategy,
        operations: {
          ...requireOperations(host.strategy),
          operate: async ({ request: committed }) => ({
            outcome: "applied",
            evidence: {
              idempotencyKey: committed.idempotencyKey,
              operationDigest: "not-the-request-digest",
              metadata: committed.metadata,
              mutation: committed.mutation,
              before: { base: asBaseVersion("a") },
              after: { base: asBaseVersion("b") },
              delivered: false,
            },
          }),
        },
      };

    const result = await operateDurableBranch(
      descriptor,
      lyingStrategy,
      request("op-1"),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(DurableOperationEvidenceError);
      expect(result.error.category).toBe("system");
    }
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["array", []],
    ["missing outcome", {}],
    ["unknown outcome", { outcome: "other" }],
    ["applied without evidence", { outcome: "applied" }],
    ["unsupported without dimensions", { outcome: "unsupported" }],
    [
      "unsupported with empty dimensions",
      {
        outcome: "unsupported",
        dimensions: [],
      },
    ],
    [
      "unsupported with an unknown dimension",
      {
        outcome: "unsupported",
        dimensions: ["other"],
      },
    ],
    [
      "unsupported with duplicate dimensions",
      {
        outcome: "unsupported",
        dimensions: ["host", "host"],
      },
    ],
  ])(
    "returns a typed error for a malformed %s outcome envelope",
    async (_label, raw) => {
      const host = createRecordingHost();
      const strategy: DurableWorkingCopyStrategy<G, DurableStoreDescriptor> = {
        ...host.strategy,
        operations: {
          ...requireOperations(host.strategy),
          operate: async () => raw as unknown as DurableOperationOutcome,
        },
      };

      const result = await operateDurableBranch(
        descriptor,
        strategy,
        request("op-1"),
      );

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(DurableOperationEvidenceError);
        expect(result.error.category).toBe("system");
      }
    },
  );

  it("refuses newly applied evidence that is already marked delivered", async () => {
    const host = createRecordingHost();
    const strategy: DurableWorkingCopyStrategy<G, DurableStoreDescriptor> = {
      ...host.strategy,
      operations: {
        ...requireOperations(host.strategy),
        operate: async ({ request: committed }) => ({
          outcome: "applied",
          evidence: {
            idempotencyKey: committed.idempotencyKey,
            operationDigest: committed.operationDigest,
            metadata: committed.metadata,
            mutation: committed.mutation,
            before: { base: asBaseVersion("a") },
            after: { base: asBaseVersion("b") },
            delivered: true,
          },
        }),
      },
    };

    const result = await operateDurableBranch(
      descriptor,
      strategy,
      request("op-1"),
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(DurableOperationEvidenceError);
      expect(result.error.category).toBe("system");
    }
  });

  it("classifies host failures as system errors and digest conflicts as constraints", async () => {
    const host = createRecordingHost();
    const failedStrategy: DurableWorkingCopyStrategy<
      G,
      DurableStoreDescriptor
    > = {
      ...host.strategy,
      operations: {
        ...requireOperations(host.strategy),
        operate: () => Promise.reject(new Error("transport unavailable")),
      },
    };

    const failed = await operateDurableBranch(
      descriptor,
      failedStrategy,
      request("op-failed"),
    );
    await operateDurableBranch(descriptor, host.strategy, request("op-1"));
    const conflict = await operateDurableBranch(
      descriptor,
      host.strategy,
      request("op-1", { metadata: { changed: true } }),
    );

    expect(isErr(failed)).toBe(true);
    expect(isErr(conflict)).toBe(true);
    if (isErr(failed)) {
      expect(failed.error).toBeInstanceOf(DurableOperationError);
      expect(failed.error.category).toBe("system");
    }
    if (isErr(conflict)) {
      expect(conflict.error).toBeInstanceOf(DurableOperationConflictError);
      expect(conflict.error.category).toBe("constraint");
    }
  });

  it("refuses malformed evidence returned by get", async () => {
    const host = createRecordingHost();
    const strategy: DurableWorkingCopyStrategy<G, DurableStoreDescriptor> = {
      ...host.strategy,
      operations: {
        ...requireOperations(host.strategy),
        get: async () => storedEvidence({ idempotencyKey: "other-key" }),
      },
    };

    const result = await getDurableOperation(descriptor, strategy, "op-1");

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(DurableOperationEvidenceError);
    }
  });

  it("refuses malformed evidence and cursors returned by scan", async () => {
    const host = createRecordingHost();
    const operations = requireOperations(host.strategy);
    const invalidEvidence: DurableWorkingCopyStrategy<
      G,
      DurableStoreDescriptor
    > = {
      ...host.strategy,
      operations: {
        ...operations,
        scan: async () => ({
          operations: [
            await storedEvidence({
              metadata: {
                createdAt: new Date(),
              } as unknown as DurableBranchOperationEvidence["metadata"],
              before: { base: asBaseVersion("") },
            }),
          ],
          cursor: "0",
          hasMore: false,
        }),
      },
    };
    const invalidCursor: DurableWorkingCopyStrategy<G, DurableStoreDescriptor> =
      {
        ...host.strategy,
        operations: {
          ...operations,
          scan: async () => ({ operations: [], cursor: "", hasMore: false }),
        },
      };

    const evidenceResult = await scanDurableOperations(
      descriptor,
      invalidEvidence,
    );
    const cursorResult = await scanDurableOperations(descriptor, invalidCursor);

    expect(isErr(evidenceResult)).toBe(true);
    expect(isErr(cursorResult)).toBe(true);
    if (isErr(evidenceResult)) {
      expect(evidenceResult.error).toBeInstanceOf(
        DurableOperationEvidenceError,
      );
    }
    if (isErr(cursorResult)) {
      expect(cursorResult.error).toBeInstanceOf(DurableOperationEvidenceError);
    }
  });

  it("refuses malformed evidence returned by markDelivered", async () => {
    const host = createRecordingHost();
    const wrongKey: DurableWorkingCopyStrategy<G, DurableStoreDescriptor> = {
      ...host.strategy,
      operations: {
        ...requireOperations(host.strategy),
        markDelivered: async () =>
          storedEvidence({ idempotencyKey: "other-key", delivered: true }),
      },
    };
    const stillUndelivered: DurableWorkingCopyStrategy<
      G,
      DurableStoreDescriptor
    > = {
      ...host.strategy,
      operations: {
        ...requireOperations(host.strategy),
        markDelivered: async () => storedEvidence(),
      },
    };

    const wrongKeyResult = await markDurableOperationDelivered(
      descriptor,
      wrongKey,
      "op-1",
    );
    const undeliveredResult = await markDurableOperationDelivered(
      descriptor,
      stillUndelivered,
      "op-1",
    );

    expect(isErr(wrongKeyResult)).toBe(true);
    expect(isErr(undeliveredResult)).toBe(true);
    if (isErr(wrongKeyResult)) {
      expect(wrongKeyResult.error).toBeInstanceOf(
        DurableOperationEvidenceError,
      );
    }
    if (isErr(undeliveredResult)) {
      expect(undeliveredResult.error).toBeInstanceOf(
        DurableOperationEvidenceError,
      );
    }
  });

  it("refuses read evidence whose digest does not bind its content", async () => {
    const host = createRecordingHost();
    const strategy: DurableWorkingCopyStrategy<G, DurableStoreDescriptor> = {
      ...host.strategy,
      operations: {
        ...requireOperations(host.strategy),
        get: async () => storedEvidence({ operationDigest: "forged-digest" }),
      },
    };

    const result = await getDurableOperation(descriptor, strategy, "op-1");

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(DurableOperationEvidenceError);
    }
  });

  it("refuses a non-boolean undelivered verdict from the host", async () => {
    const host = createRecordingHost();
    const strategy: DurableWorkingCopyStrategy<G, DurableStoreDescriptor> = {
      ...host.strategy,
      operations: {
        ...requireOperations(host.strategy),
        hasUndelivered: async () => "yes" as unknown as boolean,
      },
    };

    const result = await durableBranchHasUndeliveredEvidence(
      descriptor,
      strategy,
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(DurableOperationEvidenceError);
    }
  });
});

function requireOperations(
  strategy: DurableWorkingCopyStrategy<G, DurableStoreDescriptor>,
): NonNullable<
  DurableWorkingCopyStrategy<G, DurableStoreDescriptor>["operations"]
> {
  if (strategy.operations === undefined) {
    throw new Error("expected the recording strategy to define operations");
  }
  return strategy.operations;
}
