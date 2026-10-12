/**
 * The end-to-end half of merging identity truth: what a REAL merge writes, and
 * what it records about why.
 *
 *   - Decision provenance. A merge that changes identity classes writes
 *     transitions whose cause is `reconcile` and whose `decision` names the
 *     plan digest, the review digest it was approved under, the branch, and
 *     the root-first branch ancestry. Without it a fold triggered by a merged
 *     node create is filed as an anonymous `fold` and a reviewer replaying the
 *     class can see that it happened but not which plan produced it.
 *   - Refusal. Branches asserting opposing relations for one pair have no
 *     rule that settles them, so the merge fails and writes nothing.
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
import { IdentityMergeConflictError } from "../../src/graph-merge/errors";
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
     * Decision provenance reaches the transition log.
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
      const { transitions } = await identityTransitionsOf(ctx, {
        kind: "Person",
        id: "ada",
      });
      expect(transitions.length).toBeGreaterThan(0);
      const reconciled = transitions.filter(
        (transition) => transition.cause === "reconcile",
      );
      expect(reconciled.length).toBeGreaterThan(0);
      for (const transition of reconciled) {
        // Exactly this evidence and nothing else. One branch merged, so
        // "which branch" has an unambiguous answer; the ancestry is
        // root-first: the base graph, then the branches in anchor order.
        expect(transition.decision).toEqual({
          mergePlanDigest: artifact.digest.value,
          reviewDigest: REVIEW_DIGEST,
          branchId: BRANCH_A,
          branchAncestry: [target.graphId, BRANCH_A],
        });
      }
    });

    /**
     * The two apply paths must record the SAME ancestry for the same logical
     * merge: `merge()` has no plan artifact to read anchors from, so it
     * derives the order itself, and a second spelling of that order would make
     * replay provenance incomparable across the paths whenever the caller's
     * branch order is not already code-point sorted.
     */
    it("records one branch ancestry whether the merge is direct or applied from a plan", async () => {
      async function ancestryOf(
        apply: "direct" | "plan",
      ): Promise<readonly string[] | undefined> {
        const target = await baseWithTwoPeople();
        // Deliberately NOT in code-point order.
        const later = unwrap(
          await branch(target, () => makeBackend(), { id: BRANCH_B }),
        );
        await later.store.identity.assertSame(
          { kind: "Person", id: "ada" },
          { kind: "Person", id: "ada2" },
        );
        const earlier = unwrap(
          await branch(target, () => makeBackend(), { id: BRANCH_A }),
        );
        await earlier.store.nodes.Person.create(
          { name: "Grace" },
          { id: "grace" },
        );

        if (apply === "direct") {
          const merged = await merge(target, [later, earlier], {
            branchOrder: [BRANCH_B, BRANCH_A],
          });
          if (isErr(merged)) throw merged.error;
        } else {
          const artifact = unwrap(
            await planMerge(target, [later, earlier], {
              branchOrder: [BRANCH_B, BRANCH_A],
            }),
          );
          const applied = await applyMergePlan(target, artifact);
          if (isErr(applied)) throw applied.error;
        }

        const ctx = storeRuntime(target).identityContext();
        const { transitions } = await identityTransitionsOf(ctx, {
          kind: "Person",
          id: "ada",
        });
        const reconciled = transitions.filter(
          (transition) => transition.cause === "reconcile",
        );
        expect(reconciled.length).toBeGreaterThan(0);
        return reconciled[0]?.decision?.branchAncestry;
      }

      const direct = await ancestryOf("direct");
      const planned = await ancestryOf("plan");
      expect(direct).toEqual(planned);
      expect(direct).toEqual(["identity_reconciliation", BRANCH_A, BRANCH_B]);
    });

    /**
     * Two branches assert opposing relations for the same pair. No rule can
     * arbitrate that, so the merge fails and the target is left untouched —
     * including the unrelated node one of the branches also staged.
     */
    it("refuses branches asserting opposing relations and writes nothing", async () => {
      const target = await baseWithTwoPeople();
      const sameBranch = unwrap(
        await branch(target, () => makeBackend(), { id: BRANCH_A }),
      );
      const { assertion: sameAssertion } =
        await sameBranch.store.identity.assertSame(
          { kind: "Person", id: "ada" },
          { kind: "Person", id: "ada2" },
        );
      const differentBranch = unwrap(
        await branch(target, () => makeBackend(), { id: BRANCH_B }),
      );
      const { assertion: differentAssertion } =
        await differentBranch.store.identity.assertDifferent(
          { kind: "Person", id: "ada" },
          { kind: "Person", id: "ada2" },
        );
      await differentBranch.store.nodes.Person.create(
        { name: "Grace" },
        { id: "grace" },
      );

      const result = await merge(target, [sameBranch, differentBranch], {
        branchOrder: [BRANCH_A, BRANCH_B],
      });
      if (isOk(result)) throw new Error("expected an identity conflict");
      console.info("refusal", result.error.code, result.error.details);
      expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
      expect(result.error.code).toBe("GRAPH_MERGE_IDENTITY_CONFLICT");
      // Both staged assertions are named: neither silently disappears.
      expect(
        (
          result.error.details["assertions"] as readonly Readonly<{
            id: string;
          }>[]
        )
          .map((assertion) => assertion.id)
          .toSorted(),
      ).toEqual([sameAssertion.id, differentAssertion.id].toSorted());
      expect(await target.nodes.Person.count()).toBe(2);
      expect(
        await target.identity.areSame(
          { kind: "Person", id: "ada" },
          { kind: "Person", id: "ada2" },
        ),
      ).toBe(false);
    });
  },
);
