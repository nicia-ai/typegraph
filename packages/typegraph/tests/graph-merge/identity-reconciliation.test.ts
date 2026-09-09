/**
 * The end-to-end half of identity reconciliation: what a REAL merge writes,
 * and what it records about why.
 *
 *   - Decision provenance. A merge that changes identity classes writes
 *     transitions whose cause is `reconcile` and whose `decision` names the
 *     plan digest, the review digest it was approved under, the branch, and
 *     the root-first branch ancestry. Without it a fold triggered by a merged
 *     node create is filed as an anonymous `fold` and a reviewer replaying the
 *     class can see that it happened but not which plan produced it.
 *   - The `"flag"` / `"refuse"` split. `"flag"` means "keep the base truth,
 *     keep the data, tell me" — so its plan is APPLICABLE and carries the
 *     conflict. `"refuse"` fails the plan. Collapsing the two would make one
 *     of the policies unreachable.
 *
 * Runs on every backend in the merge matrix, because the transition log and
 * the closure it annotates are storage, not shared pure code.
 */
import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import { applyMergePlan, merge, planMerge } from "../../src/graph-merge/merge";
import { isErr, isOk, unwrap } from "../../src/graph-merge/result";
import { asBranchId } from "../../src/graph-merge/types";
import { identityTransitionsOf } from "../../src/identity/replay";
import { storeRuntime } from "../../src/store/runtime-port";
import { backendMatrix } from "./test-utils";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });

const reconciliationGraph = defineGraph({
  id: "identity_reconciliation",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});
type ReconciliationGraph = typeof reconciliationGraph;

const BRANCH_A = asBranchId("branch-a");
const BRANCH_B = asBranchId("branch-b");
const REVIEW_DIGEST = "review-digest-under-test";

describe.each(backendMatrix())(
  "identity reconciliation end to end [$name]",
  (entry) => {
    let cleanups: (() => Promise<void>)[];

    beforeEach(() => {
      cleanups = [];
    });

    afterEach(async () => {
      const outcomes = await Promise.allSettled(
        cleanups.toReversed().map((cleanup) => cleanup()),
      );
      const rejection = outcomes.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      if (rejection !== undefined) {
        throw rejection.reason instanceof Error ?
            rejection.reason
          : new Error(String(rejection.reason));
      }
    });

    async function makeBackend(): Promise<GraphBackend> {
      const fixture = await entry.make();
      cleanups.push(fixture.cleanup);
      return fixture.backend;
    }

    /** A base holding two people, ready for a branch to relate them. */
    async function baseWithTwoPeople(): Promise<Store<ReconciliationGraph>> {
      const [store] = await createStoreWithSchema(
        reconciliationGraph,
        await makeBackend(),
        { history: true },
      );
      await store.nodes.Person.create({ name: "Ada" }, { id: "ada" });
      await store.nodes.Person.create({ name: "Ada L." }, { id: "ada2" });
      return store;
    }

    /**
     * T8 — decision provenance reaches the transition log.
     *
     * A reviewed plan whose identity slice merges two classes must leave a
     * `reconcile` transition that names the governing decision, so the fold is
     * attributable to THIS plan rather than to an anonymous API write.
     */
    it("records the plan digest, review digest, branch and root-first ancestry on the transitions a reviewed apply causes", async () => {
      const target = await baseWithTwoPeople();
      const source = unwrap(
        await branch(target, () => makeBackend(), { id: BRANCH_A }),
      );
      await source.store.identity.assertSame(
        { kind: "Person", id: "ada" },
        { kind: "Person", id: "ada2" },
      );

      const artifact = unwrap(
        await planMerge(target, [source], { branchOrder: [BRANCH_A] }),
      );
      const applied = await applyMergePlan(target, artifact, {
        reviewDigest: REVIEW_DIGEST,
      });
      if (isErr(applied)) throw applied.error;
      expect(applied.data.merged.identity.asserted).toBe(1);

      const ctx = storeRuntime(target).identityContext();
      const transitions = await identityTransitionsOf(ctx, {
        kind: "Person",
        id: "ada",
      });
      expect(transitions.length).toBeGreaterThan(0);
      const reconciled = transitions.filter(
        (transition) => transition.cause === "reconcile",
      );
      expect(reconciled.length).toBeGreaterThan(0);
      for (const transition of reconciled) {
        expect(transition.decision?.mergePlanDigest).toBe(
          artifact.digest.value,
        );
        expect(transition.decision?.reviewDigest).toBe(REVIEW_DIGEST);
        // One branch merged, so "which branch" has an unambiguous answer.
        expect(transition.decision?.branchId).toBe(BRANCH_A);
        // Root-first: the base graph, then the branches in anchor order.
        expect(transition.decision?.branchAncestry).toEqual([
          target.graphId,
          BRANCH_A,
        ]);
      }
    });

    /**
     * The policy arm that DECIDED reaches the transition log. A function
     * policy is the only arm that can arbitrate an opposing-relations
     * conflict (the string arms have no assert/retract axis to decide there),
     * so it is what makes `decision.policy` observable end to end.
     */
    it("records the policy arm that arbitrated an identity conflict", async () => {
      const target = await baseWithTwoPeople();
      const sameBranch = unwrap(
        await branch(target, () => makeBackend(), { id: BRANCH_A }),
      );
      await sameBranch.store.identity.assertSame(
        { kind: "Person", id: "ada" },
        { kind: "Person", id: "ada2" },
      );
      const differentBranch = unwrap(
        await branch(target, () => makeBackend(), { id: BRANCH_B }),
      );
      await differentBranch.store.identity.assertDifferent(
        { kind: "Person", id: "ada" },
        { kind: "Person", id: "ada2" },
      );

      const result = await merge(target, [sameBranch, differentBranch], {
        branchOrder: [BRANCH_A, BRANCH_B],
        identity: {
          onAssertionConflict: (conflict) => {
            const same = conflict.asserted.find(
              (staged) => staged.assertion.relation === "same",
            );
            return same === undefined ?
                { kind: "unresolved" }
              : { kind: "assert", assertionId: same.assertion.id };
          },
        },
      });
      if (isErr(result)) throw result.error;
      expect(result.data.identityReconciliations).toHaveLength(1);
      expect(result.data.identityReconciliations[0]).toMatchObject({
        rule: "policy",
        policy: "callback",
      });
      expect(
        await target.identity.areSame(
          { kind: "Person", id: "ada" },
          { kind: "Person", id: "ada2" },
        ),
      ).toBe(true);

      const ctx = storeRuntime(target).identityContext();
      const transitions = await identityTransitionsOf(ctx, {
        kind: "Person",
        id: "ada",
      });
      const decided = transitions.filter(
        (transition) => transition.decision?.policy !== undefined,
      );
      expect(decided.length).toBeGreaterThan(0);
      for (const transition of decided) {
        expect(transition.decision?.policy).toBe("assertion:callback");
      }
    });

    /**
     * T9's end-to-end twin — `"flag"` produces an APPLICABLE plan, `"refuse"`
     * does not, from ONE fixture: two branches assert opposing relations for
     * the same pair, which no rule can arbitrate.
     */
    it("flag keeps the base truth and still merges; refuse fails the same merge", async () => {
      async function mergeUnder(
        onAssertionConflict: "refuse" | "flag",
      ): Promise<
        Readonly<{
          failed: boolean;
          conflictKinds: readonly string[];
          areSame: boolean;
          nodeCount: number;
        }>
      > {
        const target = await baseWithTwoPeople();
        const sameBranch = unwrap(
          await branch(target, () => makeBackend(), { id: BRANCH_A }),
        );
        await sameBranch.store.identity.assertSame(
          { kind: "Person", id: "ada" },
          { kind: "Person", id: "ada2" },
        );
        const differentBranch = unwrap(
          await branch(target, () => makeBackend(), { id: BRANCH_B }),
        );
        await differentBranch.store.identity.assertDifferent(
          { kind: "Person", id: "ada" },
          { kind: "Person", id: "ada2" },
        );
        // A branch that also adds data, so "the plan still applies" is
        // observable as a WRITE and not just as the absence of an error.
        await differentBranch.store.nodes.Person.create(
          { name: "Grace" },
          { id: "grace" },
        );

        const result = await merge(target, [sameBranch, differentBranch], {
          branchOrder: [BRANCH_A, BRANCH_B],
          identity: { onAssertionConflict },
        });
        return {
          failed: isErr(result),
          conflictKinds:
            isOk(result) ?
              result.data.identityConflicts.map((conflict) => conflict.kind)
            : [],
          areSame: await target.identity.areSame(
            { kind: "Person", id: "ada" },
            { kind: "Person", id: "ada2" },
          ),
          nodeCount: await target.nodes.Person.count(),
        };
      }

      const refused = await mergeUnder("refuse");
      expect(refused.failed).toBe(true);
      expect(refused.nodeCount).toBe(2);

      const flagged = await mergeUnder("flag");
      expect(flagged.failed).toBe(false);
      // The conflict is REPORTED, the base identity truth is untouched, and
      // the merge's ordinary data still lands.
      expect(flagged.conflictKinds).toContain("assertion");
      expect(flagged.areSame).toBe(false);
      expect(flagged.nodeCount).toBe(3);
    });
  },
);
