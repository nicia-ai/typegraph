/**
 * Durable-branch operations: the public orchestrators over the optional
 * `DurableWorkingCopyStrategy.operations` capability.
 *
 * A recording in-memory strategy exercises the complete public contract —
 * unsupported with zero mutation, exact replay, digest conflict, stable scan
 * pagination, idempotent delivery marking, undelivered detection, and the
 * destroy/archive fence — without a database. Atomicity of the mutation and
 * the evidence row is proven separately against PostgreSQL in
 * `tests/backends/postgres/durable-operation.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../../src";
import {
  destroyDurableBranch,
  DurableEvidenceUndeliveredError,
  DurableOperationConflictError,
  DurableOperationError,
  DurableOperationEvidenceError,
  DurableOperationUnsupportedError,
  type DurableBranchOperation,
  type DurableBranchOperationEvidence,
  type DurableBranchOperationRequest,
  type DurableBranchOrigin,
  durableBranchHasUndeliveredEvidence,
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

  const evidenceFor = (request: DurableBranchOperation): DurableBranchOperationEvidence => ({
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
          if (evidence === undefined) throw new Error(`missing evidence ${key}`);
          return evidence;
        });
        const lastIndex = start + page.length - 1;
        return lastIndex + 1 < order.length ?
            { operations, cursor: String(lastIndex) }
          : { operations };
      },
      markDelivered: async ({ expectedOrigin, idempotencyKey }) => {
        assertOrigin(expectedOrigin);
        const existing = byKey.get(idempotencyKey);
        if (existing === undefined) return undefined;
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

const descriptor = {
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
    const result = await operateDurableBranch(descriptor, host.strategy, request("op-1"));

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
    const first = await operateDurableBranch(descriptor, host.strategy, request("op-1"));
    const second = await operateDurableBranch(descriptor, host.strategy, request("op-1"));

    expect(isOk(first) && first.data.outcome === "applied").toBe(true);
    expect(isOk(second) && second.data.outcome === "replayed").toBe(true);
    if (isOk(first) && isOk(second) &&
      first.data.outcome !== "unsupported" &&
      second.data.outcome !== "unsupported") {
      expect(second.data.evidence).toEqual(first.data.evidence);
    }
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
    const withoutOperations: DurableWorkingCopyStrategy<G, DurableStoreDescriptor> =
      {
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
      metadata: { createdAt: new Date() } as unknown as DurableBranchOperationRequest["metadata"],
    });

    const result = await operateDurableBranch(descriptor, host.strategy, unsafe);

    expect(isErr(result)).toBe(true);
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
      expect(wrongKind.error).toBeInstanceOf(DurableOperationError);
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

    const result = await operateDurableBranch(stale, host.strategy, request("op-1"));

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
    expect(first.data.operations.map((operation) => operation.idempotencyKey)).toEqual([
      "op-1",
      "op-2",
    ]);
    expect(first.data.cursor).toBe("1");

    const second = await scanDurableOperations(descriptor, host.strategy, {
      after: first.data.cursor,
      limit: 2,
    });
    expect(isOk(second)).toBe(true);
    if (!isOk(second)) return;
    expect(second.data.operations.map((operation) => operation.idempotencyKey)).toEqual([
      "op-3",
      "op-4",
    ]);

    const last = await scanDurableOperations(descriptor, host.strategy, {
      after: second.data.cursor,
      limit: 2,
    });
    expect(isOk(last)).toBe(true);
    if (!isOk(last)) return;
    expect(last.data.operations.map((operation) => operation.idempotencyKey)).toEqual([
      "op-5",
    ]);
    expect(last.data.cursor).toBeUndefined();
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
    expect(isOk(beforeAny) && beforeAny.data === true).toBe(true);

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
    expect(isOk(stillUndelivered) && stillUndelivered.data === true).toBe(true);

    await markDurableOperationDelivered(descriptor, host.strategy, "op-2");
    const noneLeft = await durableBranchHasUndeliveredEvidence(
      descriptor,
      host.strategy,
    );
    expect(isOk(noneLeft) && noneLeft.data === false).toBe(true);

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
    const withoutOperations: DurableWorkingCopyStrategy<G, DurableStoreDescriptor> =
      {
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
    if (isOk(left) && isOk(right) &&
      left.data.outcome !== "unsupported" &&
      right.data.outcome !== "unsupported") {
      expect(left.data.evidence).toEqual(right.data.evidence);
      const outcomes = [left.data.outcome, right.data.outcome].sort();
      expect(outcomes).toEqual(["applied", "replayed"]);
    }
  });

  it("refuses when the host returns evidence inconsistent with the request", async () => {
    const host = createRecordingHost();
    const lyingStrategy: DurableWorkingCopyStrategy<G, DurableStoreDescriptor> = {
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
    }
  });
});

function requireOperations(
  strategy: DurableWorkingCopyStrategy<G, DurableStoreDescriptor>,
): NonNullable<DurableWorkingCopyStrategy<G, DurableStoreDescriptor>["operations"]> {
  if (strategy.operations === undefined) {
    throw new Error("expected the recording strategy to define operations");
  }
  return strategy.operations;
}
