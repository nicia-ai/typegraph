/**
 * An ordinary merge that writes identity assertions explains itself in the
 * transition log: each transition it causes carries cause `reconcile` and a
 * decision naming the branch, the branch ancestry and — when a plan artifact
 * was applied — the plan digest. The decision carries exactly that evidence
 * and nothing else.
 *
 * Every entry point records the same decision for one plan: `merge()`,
 * `applyMergePlan` (TypeGraph owns the transaction) and
 * `applyMergePlanInTransaction` (the caller does).
 *
 * Fixture: the base holds nothing; the branch creates people `a1` and `b1` and
 * asserts they are one person. The merge lands both rows and the assertion.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  type Store,
} from "../../src";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import { branch } from "../../src/graph-merge/branch";
import {
  applyMergePlan,
  applyMergePlanInTransaction,
  merge,
  planMerge,
} from "../../src/graph-merge/merge";
import { unwrap } from "../../src/graph-merge/result";
import { asBranchId } from "../../src/graph-merge/types";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });

const graph = defineGraph({
  id: "identity_decision_provenance",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});

const BRANCH = asBranchId("branch-a");
const BRANCH_ANCESTRY = [graph.id, BRANCH];

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function openBackend() {
  const { backend } = createLocalSqliteBackend();
  cleanups.push(() => backend.close());
  return backend;
}

async function branchAssertingSame() {
  const [base] = await createStoreWithSchema(graph, openBackend(), {
    history: true,
  });
  const source = unwrap(
    await branch(base, () => Promise.resolve(openBackend()), { id: BRANCH }),
  );
  for (const id of ["a1", "b1"]) {
    await source.store.nodes.Person.create({ name: id }, { id });
  }
  await source.store.identity.assertSame(
    { kind: "Person", id: "a1" },
    { kind: "Person", id: "b1" },
  );
  return { base, source };
}

async function mergeTransitions(store: Store<typeof graph>) {
  const history = await store.identity.transitionsOf({
    kind: "Person",
    id: "a1",
  });
  const transitions = history.transitions.map((transition) => ({
    cause: transition.cause,
    decision: transition.decision,
  }));
  console.info("merge transitions", JSON.stringify(transitions));
  return transitions;
}

describe("an ordinary merge records decision provenance on its transitions", () => {
  it("merge() records cause `reconcile` with the branch and its ancestry, and nothing else", async () => {
    const { base, source } = await branchAssertingSame();
    const report = unwrap(await merge(base, [source]));
    expect(report.merged.identity.asserted).toBe(1);

    expect(await mergeTransitions(base)).toEqual([
      {
        cause: "reconcile",
        decision: { branchId: BRANCH, branchAncestry: BRANCH_ANCESTRY },
      },
    ]);
  });

  it("applyMergePlan adds the plan digest, and applyMergePlanInTransaction records the same decision", async () => {
    const managed = await branchAssertingSame();
    const managedPlan = unwrap(await planMerge(managed.base, [managed.source]));
    unwrap(await applyMergePlan(managed.base, managedPlan));

    const callerOwned = await branchAssertingSame();
    const callerOwnedPlan = unwrap(
      await planMerge(callerOwned.base, [callerOwned.source]),
    );
    await callerOwned.base.transaction((tx) =>
      applyMergePlanInTransaction(callerOwned.base, tx, callerOwnedPlan),
    );

    expect(await mergeTransitions(managed.base)).toEqual([
      {
        cause: "reconcile",
        decision: {
          branchId: BRANCH,
          branchAncestry: BRANCH_ANCESTRY,
          mergePlanDigest: managedPlan.digest.value,
        },
      },
    ]);
    expect(await mergeTransitions(callerOwned.base)).toEqual([
      {
        cause: "reconcile",
        decision: {
          branchId: BRANCH,
          branchAncestry: BRANCH_ANCESTRY,
          mergePlanDigest: callerOwnedPlan.digest.value,
        },
      },
    ]);
  });
});
