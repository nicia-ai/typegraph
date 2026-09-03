import {
  asNodeId,
  createStore,
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import {
  applyMergePlan,
  asBranchId,
  branch,
  isErr,
  MergePlanCapabilityError,
  planMerge,
  StaleMergePlanError,
  unwrap,
} from "@nicia-ai/typegraph/graph-merge";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { deriveBackend } from "../../src/backend/derive-backend";
import { disableTransactions } from "../test-utils";
import { createSqliteMergeBackend } from "./test-utils";

const Item = defineNode("Item", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({
  id: "merge_callback_retries",
  nodes: { Item: { type: Item } },
  edges: {},
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function makeBackend() {
  const fixture = createSqliteMergeBackend();
  cleanups.push(fixture.cleanup);
  return fixture.backend;
}

async function fixture() {
  const backend = makeBackend();
  const [store] = await createStoreWithSchema(graph, backend, {
    history: true,
  });
  const source = unwrap(
    await branch(store, async () => makeBackend(), {
      id: asBranchId("source"),
    }),
  );
  await source.store.nodes.Item.create({ name: "planned" }, { id: "planned" });
  const plan = unwrap(await planMerge(store, [source]));
  return { store, backend, plan };
}

function conflict() {
  return Object.assign(new Error("injected serialization failure"), {
    code: "40001",
  });
}

describe("merge callback retry and refusal", () => {
  it("replays all callbacks after rollback, preserving counts and committing only the final attempt", async () => {
    const { store, plan } = await fixture();
    const beforeApply = vi.fn(() => Promise.resolve());
    let attempts = 0;
    const result = await applyMergePlan(store, plan, {
      beforeApply,
      afterApply: async (tx, applied) => {
        attempts += 1;
        expect(await tx.nodes.Item.count()).toBe(1);
        await tx.nodes.Item.create(
          { name: "application" },
          { id: `attempt-${attempts}` },
        );
        // Suppressed/JavaScript mutation of the provisional result cannot change the final report.
        Reflect.set(applied.merged, "nodes", 999);
        if (attempts === 1) throw conflict();
      },
    });
    expect(beforeApply).toHaveBeenCalledTimes(2);
    expect(unwrap(result).merged.nodes).toBe(1);
    expect(
      await store.nodes.Item.getById(asNodeId("attempt-1")),
    ).toBeUndefined();
    expect(await store.nodes.Item.getById(asNodeId("attempt-2"))).toBeDefined();
  });

  it("bounds retries and leaves every attempt rolled back", async () => {
    const { store, plan } = await fixture();
    const revision = await store.revisionNow();
    const afterApply = vi.fn(async () => {
      throw conflict();
    });
    const result = await applyMergePlan(store, plan, { afterApply });
    expect(isErr(result)).toBe(true);
    expect(afterApply).toHaveBeenCalledTimes(3);
    expect(await store.nodes.Item.count()).toBe(0);
    expect(await store.revisionNow()).toEqual(revision);
  });

  it("revalidates the fence after a rolled-back attempt and intervening committed write", async () => {
    const { backend, plan } = await fixture();
    const [writer] = await createStoreWithSchema(graph, backend, {
      history: true,
    });
    let attempts = 0;
    const retryingBackend = deriveBackend(backend, {
      transaction: async (fn, options) => {
        attempts += 1;
        try {
          return await backend.transaction(fn, options);
        } catch (error) {
          if (attempts === 1)
            await writer.nodes.Item.create({ name: "intervening" });
          throw error;
        }
      },
    });
    const store = createStore(graph, retryingBackend, { history: true });
    const beforeApply = vi.fn(() => Promise.resolve());
    const afterApply = vi.fn(async () => {
      throw conflict();
    });
    const result = await applyMergePlan(store, plan, {
      beforeApply,
      afterApply,
    });
    expect(isErr(result) && result.error).toBeInstanceOf(StaleMergePlanError);
    expect(beforeApply).toHaveBeenCalledTimes(1);
    expect(afterApply).toHaveBeenCalledTimes(1);
    expect(await store.nodes.Item.getById(asNodeId("planned"))).toBeUndefined();
  });

  it("refuses nontransactional targets before invoking callbacks", async () => {
    const { backend, plan } = await fixture();
    const store = createStore(graph, disableTransactions(backend));
    const beforeApply = vi.fn(() => Promise.resolve());
    const afterApply = vi.fn(() => Promise.resolve());
    const result = await applyMergePlan(store, plan, {
      beforeApply,
      afterApply,
    });
    expect(isErr(result) && result.error).toBeInstanceOf(
      MergePlanCapabilityError,
    );
    expect(beforeApply).not.toHaveBeenCalled();
    expect(afterApply).not.toHaveBeenCalled();
  });
});
