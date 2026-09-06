/**
 * Unit tests for the store's retry owner, {@link runRetriedUnit}, and
 * acceptance tests exercising it end to end through `store.transaction` and
 * `store.transactionWithReceipt` against real SQLite and PGlite backends.
 *
 * The last section drives import's own attempt-scoped state directly through
 * the owner: import itself is not routed through it, so the only way to prove
 * a rolled-back attempt's counts never survive is to run its write-plan
 * attempt function through `runRetriedUnit` by hand.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../src";
import {
  batchPointReadVerdict,
  createClaimsVerdictThunk,
  statementExecutionVerdict,
  uniqueSidecarBatchVerdict,
} from "../src/backend/capabilities/resolve";
import { ConfigurationError, TransactionConflictError } from "../src/errors";
import {
  buildEdgeSchemaMap,
  buildNodeSchemaMap,
  type ImportAttemptInputs,
  runImportWritePlanAttempt,
} from "../src/interchange/import";
import {
  FORMAT_VERSION,
  type GraphData,
  ImportOptionsSchema,
} from "../src/interchange/types";
import { runWritePlan } from "../src/store/operations/write-executor";
import { mixedWritePlan } from "../src/store/operations/write-plan";
import { runRetriedUnit } from "../src/store/operations/write-transaction";
import { storeBackend, storeRuntime } from "../src/store/runtime-port";
import {
  createTransactionFaultInjector,
  type FaultInjectableEngine,
  type TransactionFaultInjector,
} from "./transaction-fault-injector";

/** A pg-driver-shaped error: `code` carries the SQLSTATE. */
function pgError(code: string, message = "tx failed"): Error {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  return error;
}

describe("runRetriedUnit", () => {
  it("passes a fresh frame with the 1-based attempt number on every call", async () => {
    const seenFrames: Readonly<{ attempt: number }>[] = [];
    let attempts = 0;
    const result = await runRetriedUnit(
      { operation: "test", attempts: 3 },
      async (frame) => {
        await Promise.resolve();
        seenFrames.push(frame);
        attempts += 1;
        if (attempts < 3) throw pgError("40001");
        return "done";
      },
    );
    expect(result).toBe("done");
    expect(seenFrames.map((frame) => frame.attempt)).toEqual([1, 2, 3]);
    // A fresh object every call, never one shared/mutated frame.
    expect(new Set(seenFrames).size).toBe(seenFrames.length);
  });

  it("rethrows a non-retryable failure unchanged, without a second attempt", async () => {
    let attempts = 0;
    const failure = pgError("23505", "unique violation");
    await expect(
      runRetriedUnit({ operation: "test", attempts: 3 }, async () => {
        await Promise.resolve();
        attempts += 1;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });

  it("throws TransactionConflictError with attempts and the last failure as cause on exhaustion", async () => {
    let attempts = 0;
    const lastFailure = pgError("40001", "third strike");
    let caught: unknown;
    try {
      await runRetriedUnit(
        { operation: "widget-write", attempts: 3 },
        async () => {
          await Promise.resolve();
          attempts += 1;
          throw attempts === 3 ? lastFailure : (
              pgError("40001", `attempt ${attempts}`)
            );
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(attempts).toBe(3);
    expect(caught).toBeInstanceOf(TransactionConflictError);
    const conflict = caught as TransactionConflictError;
    expect(conflict.details).toEqual({
      operation: "widget-write",
      attempts: 3,
    });
    expect(conflict.cause).toBe(lastFailure);
  });

  it("waits with no delay before attempt 2 and a bounded, jittered delay from attempt 3 on", async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        // Fire immediately so the test does not actually wait out the delay;
        // only the REQUESTED delay is under test here.
        return originalSetTimeout(callback, 0);
      });
    try {
      let attempts = 0;
      const result = await runRetriedUnit(
        { operation: "test", attempts: 4 },
        async () => {
          await Promise.resolve();
          attempts += 1;
          if (attempts < 4) throw pgError("40001");
          return "done";
        },
      );
      expect(result).toBe("done");
      // No timer scheduled before attempt 1 (first try) or attempt 2
      // (immediate retry); one bounded, jittered delay before each of
      // attempts 3 and 4.
      expect(delays).toHaveLength(2);
      for (const delayMs of delays) {
        expect(delayMs).toBeGreaterThan(0);
        expect(delayMs).toBeLessThanOrEqual(75); // 50ms cap, jittered up to 1.5x
      }
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a non-positive-integer attempts budget (%s) without ever calling attempt",
    async (attempts) => {
      let calls = 0;
      await expect(
        runRetriedUnit({ operation: "test", attempts }, async () => {
          await Promise.resolve();
          calls += 1;
          return "unreachable";
        }),
      ).rejects.toThrow(ConfigurationError);
      expect(calls).toBe(0);
    },
  );

  it("reports the exact object it will raise through frame.reportedFailure before it raises it", async () => {
    let attempts = 0;
    const reportedByAttempt: unknown[] = [];
    let thrown: unknown;
    try {
      await runRetriedUnit(
        { operation: "widget-write", attempts: 2 },
        async (frame) => {
          await Promise.resolve();
          attempts += 1;
          const error = pgError("40001", `attempt ${attempts}`);
          // The attempt asks the frame what will be reported for this exact
          // failure before deciding what to do with it — exercised here on
          // both the retried first attempt and the exhausted second one.
          reportedByAttempt.push(frame.reportedFailure(error));
          throw error;
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(attempts).toBe(2);
    // Attempt 1 retries: the frame has nothing final to report yet, so it
    // hands back the same error unchanged rather than inventing a verdict.
    expect(reportedByAttempt[0]).toBeInstanceOf(Error);
    expect((reportedByAttempt[0] as Error).message).toBe("attempt 1");
    // Attempt 2 exhausts the budget: what the frame reported is REFERENCE-
    // EQUAL to what runRetriedUnit actually threw, not a second, separately
    // minted TransactionConflictError with the same shape.
    expect(thrown).toBeInstanceOf(TransactionConflictError);
    expect(reportedByAttempt[1]).toBe(thrown);
  });
});

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });

const RETRY_ACCEPTANCE_GRAPH = defineGraph({
  id: "transaction-retry-acceptance",
  nodes: { Person: { type: Person } },
  edges: {},
});

const ENGINES: readonly FaultInjectableEngine[] = ["sqlite", "pglite"];

const injectorsToClose: TransactionFaultInjector[] = [];
afterEach(async () => {
  await Promise.all(
    injectorsToClose.splice(0).map((injector) => injector.close()),
  );
});

async function buildFaultyStore(
  engine: FaultInjectableEngine,
  faultOptions: Parameters<typeof createTransactionFaultInjector>[1],
  storeOptions?: Parameters<typeof createStoreWithSchema>[2],
) {
  const injector = await createTransactionFaultInjector(engine, faultOptions);
  injectorsToClose.push(injector);
  const [store] = await createStoreWithSchema(
    RETRY_ACCEPTANCE_GRAPH,
    injector.backend,
    storeOptions,
  );
  // Schema bootstrap issues transactions and write statements of its own;
  // arming only now means both fault triggers count from the transaction
  // under test, not from store creation.
  injector.arm();
  return { injector, store };
}

describe.each(ENGINES)("store.transaction retry (%s)", (engine) => {
  it("replays the whole callback once per outer attempt and commits on the attempt that succeeds", async () => {
    const { injector, store } = await buildFaultyStore(engine, {
      shape: "40001",
      failAtStatementCall: 1,
    });

    let innerRuns = 0;
    const created = await store.transaction(
      async (tx) => {
        innerRuns += 1;
        return tx.nodes.Person.create({ name: "Alice" }, { id: "alice" });
      },
      { retry: { attempts: 3 } },
    );

    // The first statement of attempt 1 conflicts before any further
    // statement of that attempt runs, so the inner unit sees exactly one
    // call per outer attempt rather than retrying internally.
    expect(innerRuns).toBe(2);
    expect(injector.commitAttempts()).toBe(2);
    expect(created.id).toBe("alice");
    expect(await store.nodes.Person.getById(created.id)).toBeDefined();
  });

  it("without retry, the same conflict surfaces as TransactionConflictError with attempts: 1", async () => {
    const { injector, store } = await buildFaultyStore(engine, {
      shape: "40001",
      failAtStatementCall: 1,
    });

    let caught: unknown;
    try {
      await store.transaction(async (tx) => {
        await tx.nodes.Person.create({ name: "Alice" }, { id: "alice" });
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TransactionConflictError);
    const conflict = caught as TransactionConflictError;
    expect(conflict.details).toEqual({
      operation: "store.transaction()",
      attempts: 1,
    });
    expect(conflict.cause).toBe(injector.lastFault());
    expect(injector.commitAttempts()).toBe(1);
    expect(await store.nodes.Person.getById("alice" as never)).toBeUndefined();
  });

  it("transactionWithReceipt: only the committed attempt's hooks and receipt are reported", async () => {
    const starts: number[] = [];
    let ends = 0;
    const errors: Error[] = [];
    const { injector, store } = await buildFaultyStore(
      engine,
      { shape: "40001", failCommits: 1 },
      {
        hooks: {
          onOperationStart: (ctx) => starts.push(ctx.attempt ?? 1),
          onOperationEnd: () => {
            ends += 1;
          },
          onError: (_ctx, error) => errors.push(error),
        },
      },
    );

    const outcome = await store.transactionWithReceipt(
      async (tx) => {
        await tx.nodes.Person.create({ name: "Alice" }, { id: "alice" });
        await tx.nodes.Person.create({ name: "Bob" }, { id: "bob" });
      },
      { retry: { attempts: 2 } },
    );

    expect(injector.commitAttempts()).toBe(2);
    expect(outcome.receipt.writes.nodes["Person"]).toBe(2);
    expect(outcome.receipt.writes.total).toBe(2);
    // Two starts from the conflicted first attempt, two from the one that
    // committed — the first attempt's `onOperationEnd` never fires, so a
    // fresh receipt recorder per attempt is the only way the count above
    // reads 2 rather than 4.
    expect(starts).toEqual([1, 1, 2, 2]);
    expect(ends).toBe(2);
    expect(errors).toEqual([]);
  });

  it("a rolled-back attempt's completed operation reports neither onOperationEnd nor onError, and its write never reaches the store", async () => {
    const endedIds: string[] = [];
    const errors: Error[] = [];
    const { store } = await buildFaultyStore(
      engine,
      { shape: "40001", failCommits: 1 },
      {
        hooks: {
          onOperationEnd: (ctx) => endedIds.push(ctx.id),
          onError: (_ctx, error) => errors.push(error),
        },
      },
    );

    let attemptCount = 0;
    await store.transaction(
      async (tx) => {
        attemptCount += 1;
        // Each attempt takes a different branch, proving the buffer that
        // flushes is the COMMITTED attempt's own, not a merge of every try.
        if (attemptCount === 1) {
          await tx.nodes.Person.create({ name: "A" }, { id: "person-a" });
        } else {
          await tx.nodes.Person.create({ name: "B" }, { id: "person-b" });
        }
      },
      { retry: { attempts: 2 } },
    );

    expect(endedIds).toEqual(["person-b"]);
    expect(errors).toEqual([]);
    expect(
      await store.nodes.Person.getById("person-a" as never),
    ).toBeUndefined();
    expect(await store.nodes.Person.getById("person-b" as never)).toBeDefined();
  });

  it("retries a failure whose message carries the pattern but no SQLSTATE at all", async () => {
    const { injector, store } = await buildFaultyStore(engine, {
      shape: "message-only",
      failCommits: 1,
    });

    const created = await store.transaction(
      (tx) => tx.nodes.Person.create({ name: "Alice" }, { id: "alice" }),
      { retry: { attempts: 2 } },
    );

    expect(created.id).toBe("alice");
    expect(injector.commitAttempts()).toBe(2);
  });

  it("does not retry a non-retryable failure and reports it through onError exactly once", async () => {
    const errors: Error[] = [];
    const { injector, store } = await buildFaultyStore(
      engine,
      { shape: "23505", failCommits: 3 },
      { hooks: { onError: (_ctx, error) => errors.push(error) } },
    );

    let caught: unknown;
    try {
      await store.transaction(
        async (tx) => {
          await tx.nodes.Person.create({ name: "Alice" }, { id: "alice" });
        },
        { retry: { attempts: 3 } },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(injector.lastFault());
    expect(injector.commitAttempts()).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(injector.lastFault());
  });

  it("on final failure after the retry budget is exhausted, every buffered success converts to onError exactly once, carrying the same TransactionConflictError the caller receives", async () => {
    const errors: Error[] = [];
    const { injector, store } = await buildFaultyStore(
      engine,
      { shape: "40001", failCommits: 3 },
      { hooks: { onError: (_ctx, error) => errors.push(error) } },
    );

    let caught: unknown;
    try {
      await store.transaction(
        async (tx) => {
          await tx.nodes.Person.create({ name: "Alice" }, { id: "alice" });
          await tx.nodes.Person.create({ name: "Bob" }, { id: "bob" });
        },
        { retry: { attempts: 2 } },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TransactionConflictError);
    const conflict = caught as TransactionConflictError;
    expect(conflict.details).toEqual({
      operation: "store.transaction()",
      attempts: 2,
    });
    expect(conflict.cause).toBe(injector.lastFault());
    // Both attempts ran and both committed for real (the injector's
    // failCommits: 3 rolls each one back after the callback runs), so both
    // creates in the last (2nd) attempt buffered a success.
    expect(injector.commitAttempts()).toBe(2);
    expect(errors).toHaveLength(2);
    for (const error of errors) {
      // The SAME TransactionConflictError object the caller caught, not a
      // second one minted independently with the same shape, and not the
      // raw driver error either.
      expect(error).toBe(conflict);
    }
    expect(await store.nodes.Person.count()).toBe(0);
  });

  it("a throwing onError hook never replaces the failure being reported", async () => {
    // Without retry the conflict must reach the caller as the conflict, not
    // as the hook's exception; and a nested unit's failure must reach an
    // enclosing retry owner intact so it can still be classified and retried.
    const { injector, store } = await buildFaultyStore(
      engine,
      { shape: "40001", failCommits: 1 },
      {
        hooks: {
          onError: () => {
            throw new Error("hook boom");
          },
        },
      },
    );

    let caught: unknown;
    try {
      await store.transaction(async (tx) => {
        await tx.nodes.Person.create({ name: "Alice" }, { id: "alice" });
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TransactionConflictError);
    expect((caught as TransactionConflictError).cause).toBe(
      injector.lastFault(),
    );

    // The owner sees the original conflict, so a retried transaction still
    // succeeds on its second attempt.
    const { injector: retried, store: retriedStore } = await buildFaultyStore(
      engine,
      { shape: "40001", failCommits: 1 },
      {
        hooks: {
          onError: () => {
            throw new Error("hook boom");
          },
        },
      },
    );
    await retriedStore.transaction(
      async (tx) => {
        await tx.nodes.Person.create({ name: "Bob" }, { id: "bob" });
      },
      { retry: { attempts: 2 } },
    );
    expect(retried.commitAttempts()).toBe(2);
    expect(await retriedStore.nodes.Person.count()).toBe(1);
  });

  it("a throwing onError hook on a statement-level conflict still lets the owner retry", async () => {
    // The immediate per-operation onError path, not the transaction-level
    // conversion: the first write statement of attempt 1 conflicts, the
    // operation's own onError fires and throws, and the owner must still
    // see the conflict — not the hook's exception — and replay.
    const { injector, store } = await buildFaultyStore(
      engine,
      { shape: "40001", failAtStatementCall: 1 },
      {
        hooks: {
          onError: () => {
            throw new Error("hook boom");
          },
        },
      },
    );
    await store.transaction(
      async (tx) => {
        await tx.nodes.Person.create({ name: "Carol" }, { id: "carol" });
      },
      { retry: { attempts: 2 } },
    );
    expect(injector.commitAttempts()).toBe(2);
    expect(await store.nodes.Person.count()).toBe(1);
  });

  it("a throwing onOperationEnd hook cannot retry an attempt whose backend transaction already committed", async () => {
    const hookFailure = pgError("40001", "hook boom");
    const { store } = await buildFaultyStore(
      engine,
      // No trigger armed: only the hook itself fails, after a real commit.
      { shape: "40001" },
      {
        hooks: {
          onOperationEnd: () => {
            throw hookFailure;
          },
        },
      },
    );

    let callbackRuns = 0;
    await expect(
      store.transaction(
        async (tx) => {
          callbackRuns += 1;
          await tx.nodes.Person.create({ name: "Alice" }, { id: "alice" });
        },
        { retry: { attempts: 2 } },
      ),
    ).rejects.toBe(hookFailure);

    // The backend transaction already committed once, for real, before the
    // hook ran. A hook failure — even one shaped like a serialization
    // failure — must propagate once, never replay a durable commit.
    expect(callbackRuns).toBe(1);
    expect(await store.nodes.Person.count()).toBe(1);
  });

  it("refuses store.transaction's retry.attempts when it is not a positive integer, without invoking the callback", async () => {
    const { store } = await buildFaultyStore(engine, { shape: "40001" });

    let callbackRuns = 0;
    await expect(
      store.transaction(
        async (tx) => {
          callbackRuns += 1;
          await tx.nodes.Person.create({ name: "Alice" }, { id: "alice" });
        },
        { retry: { attempts: 0 } },
      ),
    ).rejects.toThrow(ConfigurationError);

    expect(callbackRuns).toBe(0);
    expect(await store.nodes.Person.count()).toBe(0);
  });
});

describe.each(ENGINES)("import write-plan attempt state (%s)", (engine) => {
  it("reports exactly the second attempt's created counts and errors when the first attempt's commit conflicts", async () => {
    const { injector, store } = await buildFaultyStore(engine, {
      shape: "40001",
      failCommits: 1,
    });

    const graphId = store.graphId;
    const registry = store.registry;
    const backend = storeBackend(store);
    const runtime = storeRuntime(store);
    const data: GraphData = {
      formatVersion: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      source: { type: "external", description: "retry-owner test" },
      nodes: [
        { kind: "Person", id: "alice", properties: { name: "Alice" } },
        { kind: "Person", id: "bob", properties: { name: "Bob" } },
      ],
      edges: [],
    };
    const options = ImportOptionsSchema.parse({ onConflict: "skip" });
    const attemptInputs: ImportAttemptInputs<typeof RETRY_ACCEPTANCE_GRAPH> = {
      graphId,
      registry,
      data,
      nodeSchemas: buildNodeSchemaMap(store.graph),
      edgeSchemas: buildEdgeSchemaMap(store.graph),
      options,
      runtime,
      batchPointRead: batchPointReadVerdict(backend),
      uniqueSidecarBatch: uniqueSidecarBatchVerdict(backend),
      statementExecution: statementExecutionVerdict(backend),
    };

    // Drives import's write-plan attempt function directly through the
    // retry owner and a fault-injected backend — import itself is never
    // routed through `runRetriedUnit` in production; this is the seam
    // that proves `createImportAttemptState()` gives every attempt a
    // clean slate regardless.
    const attemptState = await runRetriedUnit(
      { operation: "import-attempt-test", attempts: 2 },
      () =>
        runWritePlan(
          {
            graphId,
            registry,
            claimsVerdict: createClaimsVerdictThunk(backend),
            uniqueSidecarBatch: attemptInputs.uniqueSidecarBatch,
            statementExecution: attemptInputs.statementExecution,
            schemaVersion: store.introspect().schemaVersion,
            historyEnabled: store.historyEnabled,
            revisionTrackingEnabled: store.revisionTrackingEnabled,
            revisionSchema: store.revisionSchema,
            identityLock: (target) => runtime.lockIdentityImportTarget(target),
          },
          mixedWritePlan(undefined, true),
          backend,
          (session, target, overlaidSession, _lock, transactionMode) =>
            runImportWritePlanAttempt(
              attemptInputs,
              session,
              target,
              overlaidSession,
              transactionMode,
            ),
        ),
    );

    // The first attempt's commit conflicted after inserting both nodes for
    // real; had their counts survived into the second attempt (the bug a
    // counter hoisted outside the attempt factory would reintroduce), this
    // would read 4, not 2.
    expect(injector.commitAttempts()).toBe(2);
    expect(attemptState.result.nodes.created).toBe(2);
    expect(attemptState.result.nodes.updated).toBe(0);
    expect(attemptState.result.nodes.skipped).toBe(0);
    expect(attemptState.errors).toEqual([]);
    expect(await store.nodes.Person.count()).toBe(2);
  });
});
