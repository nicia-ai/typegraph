/**
 * An approved merge plan records the same identity decision in the transition
 * log whichever entry point applies it: `applyMergePlan` (TypeGraph owns the
 * transaction) or `applyMergePlanInTransaction` (the caller does). Both build
 * the decision from the artifact through `mergeIdentityDecisionFromArtifact`,
 * so the policy arm the review recorded — here `onEdgeConflict: "flag"` — is
 * never dropped by one of them.
 *
 * Fixture (as in `identity-flag-rebuild.test.ts`): the base holds company `x`;
 * the branch creates `a1` and `b1`, each `worksAt` `x`, and asserts they are
 * one person. Fusing them would collapse the two relationships onto one edge
 * slot, so the flag policy drops the pairing and reports an `edge` conflict
 * while the `same` assertion itself still lands — noting a transition.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type Store,
} from "../../src";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import type { IdentityDecisionProvenance } from "../../src/graph-merge";
import { branch } from "../../src/graph-merge/branch";
import {
  applyMergePlan,
  applyMergePlanInTransaction,
  planMerge,
} from "../../src/graph-merge/merge";
import { unwrap } from "../../src/graph-merge/result";
import { asBranchId } from "../../src/graph-merge/types";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const worksAt = defineEdge("worksAt", { schema: z.object({}) });

const graph = defineGraph({
  id: "identity_decision_apply_parity",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: { worksAt: { type: worksAt, from: [Person], to: [Company] } },
  identity: { sameIdAcrossKinds: "ignore" },
});

const BRANCH = asBranchId("branch-a");

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function openBackend() {
  const { backend } = createLocalSqliteBackend();
  cleanups.push(() => backend.close());
  return backend;
}

async function flaggedEdgeConflictPlan() {
  const [base] = await createStoreWithSchema(graph, openBackend(), {
    history: true,
  });
  await base.nodes.Company.create({ name: "X" }, { id: "x" });
  const source = unwrap(
    await branch(base, () => Promise.resolve(openBackend()), { id: BRANCH }),
  );
  for (const id of ["a1", "b1"]) {
    await source.store.nodes.Person.create({ name: id }, { id });
    await source.store.edges.worksAt.create(
      { kind: "Person", id },
      { kind: "Company", id: "x" },
      {},
    );
  }
  await source.store.identity.assertSame(
    { kind: "Person", id: "a1" },
    { kind: "Person", id: "b1" },
  );
  const artifact = unwrap(
    await planMerge(base, [source], {
      branchOrder: [BRANCH],
      identity: { pairing: "definitional", onEdgeConflict: "flag" },
    }),
  );
  expect(artifact.review.identityConflicts).toEqual([
    expect.objectContaining({ kind: "edge", edgeKind: "worksAt" }),
  ]);
  return { base, artifact };
}

async function recordedDecisions(
  store: Store<typeof graph>,
): Promise<readonly IdentityDecisionProvenance[]> {
  const history = await store.identity.transitionsOf({
    kind: "Person",
    id: "a1",
  });
  return history.transitions.flatMap((transition) =>
    transition.decision === undefined ? [] : [transition.decision],
  );
}

describe("merge plan apply entry points record the same identity decision", () => {
  it("records the flagged edge policy through applyMergePlan and applyMergePlanInTransaction alike", async () => {
    const managed = await flaggedEdgeConflictPlan();
    unwrap(await applyMergePlan(managed.base, managed.artifact));

    const callerOwned = await flaggedEdgeConflictPlan();
    await callerOwned.base.transaction((tx) =>
      applyMergePlanInTransaction(callerOwned.base, tx, callerOwned.artifact),
    );

    const managedDecisions = await recordedDecisions(managed.base);
    const callerOwnedDecisions = await recordedDecisions(callerOwned.base);
    console.info("decisions", { managedDecisions, callerOwnedDecisions });
    expect(managedDecisions).toEqual([
      expect.objectContaining({ policy: { edge: "flag" } }),
    ]);
    expect(
      callerOwnedDecisions.map((decision) => ({
        ...decision,
        mergePlanDigest: undefined,
      })),
    ).toEqual(
      managedDecisions.map((decision) => ({
        ...decision,
        mergePlanDigest: undefined,
      })),
    );
  });
});
