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
 *
 * A transition the merge causes through a NODE write rather than an identity
 * row keeps the cause that names its mechanism — `detach` for a deleted
 * member, `fold` for a created same-ID peer — and carries the same decision.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
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

const Org = defineNode("Org", { schema: z.object({ name: z.string() }) });

const foldGraph = defineGraph({
  id: "identity_decision_provenance_fold",
  nodes: { Person: { type: Person }, Org: { type: Org } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

const FOLD_BRANCH_ANCESTRY = [foldGraph.id, BRANCH];

type FoldStore = Store<typeof foldGraph>;

async function forkedFoldBase(seed: (base: FoldStore) => Promise<void>) {
  const [base] = await createStoreWithSchema(foldGraph, openBackend(), {
    history: true,
  });
  await seed(base);
  const source = unwrap(
    await branch(base, () => Promise.resolve(openBackend()), { id: BRANCH }),
  );
  return { base, source };
}

/** The base holds `a1` and `b1` as one person; the branch deletes `a1`. */
async function branchDeletingAClassMember() {
  const forked = await forkedFoldBase(async (base) => {
    for (const id of ["a1", "b1"]) {
      await base.nodes.Person.create({ name: id }, { id });
    }
    await base.identity.assertSame(
      { kind: "Person", id: "a1" },
      { kind: "Person", id: "b1" },
    );
  });
  await forked.source.store.nodes.Person.delete(asNodeId("a1"));
  return forked;
}

/** The base holds the org `a1`; the branch creates the person `a1`. */
async function branchCreatingASameIdPeer() {
  const forked = await forkedFoldBase(async (base) => {
    await base.nodes.Org.create({ name: "a1" }, { id: "a1" });
  });
  await forked.source.store.nodes.Person.create({ name: "a1" }, { id: "a1" });
  return forked;
}

async function decisionOfCause(store: FoldStore, cause: "detach" | "fold") {
  const history = await store.identity.transitionsOf({
    kind: "Person",
    id: "a1",
  });
  console.info(
    `${cause} transitions`,
    JSON.stringify(
      history.transitions.map((transition) => ({
        cause: transition.cause,
        decision: transition.decision,
      })),
    ),
  );
  const caused = history.transitions.filter(
    (transition) => transition.cause === cause,
  );
  expect(caused).toHaveLength(1);
  return caused[0]?.decision;
}

describe("a transition a merge-applied node write causes carries the merge's decision", () => {
  it("merge() records the branch on the detach a merged delete causes", async () => {
    const { base, source } = await branchDeletingAClassMember();
    unwrap(await merge(base, [source]));

    expect(await decisionOfCause(base, "detach")).toEqual({
      branchId: BRANCH,
      branchAncestry: FOLD_BRANCH_ANCESTRY,
    });
  });

  it("merge() records the branch on the fold a merged create causes", async () => {
    const { base, source } = await branchCreatingASameIdPeer();
    unwrap(await merge(base, [source]));

    expect(await decisionOfCause(base, "fold")).toEqual({
      branchId: BRANCH,
      branchAncestry: FOLD_BRANCH_ANCESTRY,
    });
  });

  it("applyMergePlan and applyMergePlanInTransaction record the plan digest on the detach", async () => {
    const managed = await branchDeletingAClassMember();
    const managedPlan = unwrap(await planMerge(managed.base, [managed.source]));
    unwrap(await applyMergePlan(managed.base, managedPlan));

    const callerOwned = await branchDeletingAClassMember();
    const callerOwnedPlan = unwrap(
      await planMerge(callerOwned.base, [callerOwned.source]),
    );
    await callerOwned.base.transaction((tx) =>
      applyMergePlanInTransaction(callerOwned.base, tx, callerOwnedPlan),
    );

    expect(await decisionOfCause(managed.base, "detach")).toEqual({
      branchId: BRANCH,
      branchAncestry: FOLD_BRANCH_ANCESTRY,
      mergePlanDigest: managedPlan.digest.value,
    });
    expect(await decisionOfCause(callerOwned.base, "detach")).toEqual({
      branchId: BRANCH,
      branchAncestry: FOLD_BRANCH_ANCESTRY,
      mergePlanDigest: callerOwnedPlan.digest.value,
    });
  });
});
