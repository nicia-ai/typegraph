import type { GraphBackend } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import { IdentityMergeConflictError } from "../../src/graph-merge/errors";
import { merge, planIdentityChanges } from "../../src/graph-merge/merge";
import { isErr, isOk, unwrap } from "../../src/graph-merge/result";
import { stageBranches } from "../../src/graph-merge/staging";
import { backendMatrix } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "identity-merge",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

describe.each(backendMatrix())("identity merge [$name]", (entry) => {
  let cleanups: (() => Promise<void>)[];

  beforeEach(() => {
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
  });

  async function makeBackend(): Promise<GraphBackend> {
    const fixture = await entry.make();
    cleanups.push(fixture.cleanup);
    return fixture.backend;
  }

  async function createBase(withAssertion = false) {
    const [store] = await createStoreWithSchema(graph, await makeBackend());
    const first = await store.nodes.Person.create(
      { name: "First" },
      { id: "first" },
    );
    const second = await store.nodes.Person.create(
      { name: "Second" },
      { id: "second" },
    );
    const assertion =
      withAssertion ?
        await store.identity.assertSame(first, second)
      : undefined;
    return { store, first, second, assertion };
  }

  it("preserves assertion id and validFrom in an empty working-copy clone", async () => {
    const { store, assertion, first } = await createBase(true);
    const fork = unwrap(await branch(store, () => makeBackend()));

    expect(await fork.store.identity.assertionsOf(first)).toEqual([assertion]);
  });

  it("chooses the same deterministic survivor for every branch permutation", async () => {
    const { store, first, second } = await createBase();
    const branchA = unwrap(await branch(store, () => makeBackend()));
    const branchB = unwrap(await branch(store, () => makeBackend()));
    const firstAssertion = await branchA.store.identity.assertSame(
      first,
      second,
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    await branchB.store.identity.assertSame(first, second);

    const forward = planIdentityChanges(
      await stageBranches(store, [branchA, branchB]),
    );
    const reverse = planIdentityChanges(
      await stageBranches(store, [branchB, branchA]),
    );
    expect(reverse).toEqual(forward);
    expect(forward.assertions).toEqual([
      expect.objectContaining({ id: firstAssertion.id }),
    ]);

    expect(isOk(await merge(store, [branchA, branchB], {}))).toBe(true);
    expect(await store.identity.assertionsOf(first)).toEqual([firstAssertion]);
  });

  it("rejects opposing assertions as a typed merge conflict", async () => {
    const { store, first, second } = await createBase();
    const sameBranch = unwrap(await branch(store, () => makeBackend()));
    const differentBranch = unwrap(await branch(store, () => makeBackend()));
    await sameBranch.store.identity.assertSame(first, second);
    await differentBranch.store.identity.assertDifferent(first, second);

    const result = await merge(store, [sameBranch, differentBranch], {});
    expect(isErr(result)).toBe(true);
    if (isOk(result)) throw new Error("Expected identity merge conflict");
    expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
  });

  it("rejects retract/reassert races as a typed merge conflict", async () => {
    const { store, first, second, assertion } = await createBase(true);
    if (assertion === undefined) throw new Error("Missing base assertion");
    const retractBranch = unwrap(await branch(store, () => makeBackend()));
    const reassertBranch = unwrap(await branch(store, () => makeBackend()));
    await retractBranch.store.identity.retractAssertion(assertion.id);
    await reassertBranch.store.identity.retractAssertion(assertion.id);
    await reassertBranch.store.identity.assertSame(first, second);

    const result = await merge(store, [retractBranch, reassertBranch], {});
    expect(isErr(result)).toBe(true);
    if (isOk(result)) throw new Error("Expected identity merge conflict");
    expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
  });
});
