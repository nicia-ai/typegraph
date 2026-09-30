/**
 * `computeBaseVersionAtTarget` and the transaction pre-commit hook it is built
 * for: a caller inside a write transaction reads the base version of the state
 * COMMIT will publish, on the transaction's own session, in every mode that
 * defers write-side bookkeeping (recorded-time capture flush, revision-clock
 * advance) until after the callback returns.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../../src";
import type { TransactionBackend } from "../../src/backend/types";
import { CompilerInvariantError } from "../../src/errors";
import {
  computeBaseVersion,
  computeBaseVersionAtTarget,
} from "../../src/graph-merge/base-version";
import {
  beginPreCommitHookAttempt,
  claimTransactionPreCommitHook,
  settleTransactionPreCommitHook,
  withTransactionPreCommitHook,
} from "../../src/store/recorded-capture";
import { transactionBackend } from "../../src/store/runtime-port";
import { createStore, type Store } from "../../src/store/store";
import { createTestBackend } from "../test-utils";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({
  id: "base-version-at-target",
  nodes: { Person: { type: Person } },
  edges: {},
});

const MODES = [
  { label: "recorded-time capture", options: { history: true } },
  { label: "revision tracking", options: { revisionTracking: true } },
  { label: "content fingerprint", options: {} },
] as const;

function createModeStore(options: (typeof MODES)[number]["options"]) {
  return createStore(graph, createTestBackend(), options);
}

async function commitWithPreCommitBase(store: Store<typeof graph>) {
  const observed: string[] = [];
  let hookCalls = 0;
  await store.transaction(
    async (transaction) => {
      await transaction.nodes.Person.create({ name: "Alice" });
    },
    withTransactionPreCommitHook(undefined, async (target) => {
      hookCalls += 1;
      observed.push(await computeBaseVersionAtTarget(store, target));
    }),
  );
  return { observed, hookCalls };
}

describe.each(MODES)("$label", ({ options }) => {
  it("mints the committed token for a quiet transaction", async () => {
    const store = createModeStore(options);
    await store.nodes.Person.create({ name: "Seed" });
    const expected = await computeBaseVersion(store);
    const observed = await store.transaction(async (transaction) =>
      computeBaseVersionAtTarget(store, transactionBackend(transaction)),
    );
    expect(observed).toBe(expected);
  });

  it("observes the state the commit publishes, exactly once", async () => {
    const store = createModeStore(options);
    await store.nodes.Person.create({ name: "Seed" });
    const before = await computeBaseVersion(store);
    const { observed, hookCalls } = await commitWithPreCommitBase(store);
    expect(hookCalls).toBe(1);
    expect(observed).toHaveLength(1);
    expect(observed[0]).not.toBe(before);
    expect(observed[0]).toBe(await computeBaseVersion(store));
  });

  it("fires the hook once for every transaction that reuses the same options", async () => {
    const store = createModeStore(options);
    let hookCalls = 0;
    const reusedOptions = withTransactionPreCommitHook(undefined, () => {
      hookCalls += 1;
      return Promise.resolve();
    });
    for (const name of ["Alice", "Bob"]) {
      await store.transaction(async (transaction) => {
        await transaction.nodes.Person.create({ name });
      }, reusedOptions);
    }
    expect(hookCalls).toBe(2);
  });

  it("rolls the transaction back when the pre-commit hook throws", async () => {
    const store = createModeStore(options);
    await expect(
      store.transaction(
        async (transaction) => {
          await transaction.nodes.Person.create({ name: "Alice" });
        },
        withTransactionPreCommitHook(undefined, () =>
          Promise.reject(new Error("pre-commit refused")),
        ),
      ),
    ).rejects.toThrow("pre-commit refused");
    expect(await store.nodes.Person.count()).toBe(0);
  });
});

describe("the pre-commit hook's single firing owner", () => {
  async function withTarget(
    use: (target: TransactionBackend) => Promise<void>,
  ): Promise<void> {
    await createTestBackend().transaction(use);
  }

  it("fires an unclaimed hook exactly once when the Store settles it", async () => {
    let hookCalls = 0;
    const attempt = beginPreCommitHookAttempt(
      withTransactionPreCommitHook(undefined, () => {
        hookCalls += 1;
        return Promise.resolve();
      }),
    );
    await withTarget(async (target) => {
      await settleTransactionPreCommitHook(attempt, target);
      await settleTransactionPreCommitHook(attempt, target);
    });
    expect(hookCalls).toBe(1);
  });

  it("leaves a claimed hook to its claimant and refuses a second firing", async () => {
    let hookCalls = 0;
    const attempt = beginPreCommitHookAttempt(
      withTransactionPreCommitHook(undefined, () => {
        hookCalls += 1;
        return Promise.resolve();
      }),
    );
    const fire = claimTransactionPreCommitHook(attempt);
    expect(fire).toBeDefined();
    expect(claimTransactionPreCommitHook(attempt)).toBeUndefined();
    await withTarget(async (target) => {
      await settleTransactionPreCommitHook(attempt, target);
      expect(hookCalls).toBe(0);
      await fire?.(target);
      expect(hookCalls).toBe(1);
      await expect(fire?.(target)).rejects.toBeInstanceOf(
        CompilerInvariantError,
      );
    });
    expect(hookCalls).toBe(1);
  });

  it("is a no-op for a transaction without a hook", async () => {
    await withTarget(async (target) => {
      expect(claimTransactionPreCommitHook(undefined)).toBeUndefined();
      await settleTransactionPreCommitHook(undefined, target);
    });
  });
});
