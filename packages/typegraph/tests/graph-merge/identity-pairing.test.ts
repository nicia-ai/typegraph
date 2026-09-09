/**
 * Identity-driven candidate pairing and the always-on separation veto.
 *
 * Two decisions are under test and they are deliberately independent:
 *
 *   - `identity.pairing` turns an explicit `same` assertion into candidate
 *     recall — off by default, so a merge that never states it behaves exactly
 *     as it always has.
 *   - the separation veto runs for EVERY identity-enabled merge regardless of
 *     `pairing`, because a `different` assertion is an integrity fact. What
 *     used to abort inside the commit on the separation relation's
 *     ordered-pair CHECK is refused at plan time, naming both entities.
 *
 * Both application points of the veto are covered: the candidate-edge veto
 * (a forced edge whose endpoints are class-lifted `different`) and the
 * post-cluster assertion (a TRANSITIVE fusion through a third node, where no
 * single candidate edge is separated).
 *
 * Runs on every backend in the merge matrix (SQLite + in-process PGlite, plus
 * server Postgres when `POSTGRES_URL` is set) — the pairing decision is shared
 * code, the separation probe is not, so both must agree.
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
import { merge, mergeIncremental } from "../../src/graph-merge/merge";
import { isErr, isOk, unwrap } from "../../src/graph-merge/result";
import { asBranchId } from "../../src/graph-merge/types";
import { backendMatrix } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), email: z.string() }),
});
const Robot = defineNode("Robot", {
  schema: z.object({ name: z.string(), email: z.string() }),
});

const pairingGraph = defineGraph({
  id: "identity_pairing",
  nodes: {
    Person: {
      type: Person,
      unique: [
        {
          name: "person_email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Robot: { type: Robot },
  },
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});
type PairingGraph = typeof pairingGraph;

/**
 * The same kinds with NO unique constraint, so the new-vs-base sources pull no
 * base members into scope. That keeps the component-level base guard (which
 * refuses to collapse two COMMITTED entities on its own) out of the way, so the
 * transitive case below exercises the post-cluster separation assertion rather
 * than a base-ambiguity split.
 */
const similarityGraph = defineGraph({
  id: "identity_pairing_similarity",
  nodes: { Person: { type: Person }, Robot: { type: Robot } },
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});
type SimilarityGraph = typeof similarityGraph;

/**
 * A resolve config whose SCORING never accepts anything: the forced
 * (definitional) edges a unique constraint or an identity assertion produces
 * still pass through, so a test can drive the forced path alone.
 */
const FORCED_ONLY_RESOLVE = {
  block: () => "all",
  threshold: 1,
  similarity: { kind: "custom", score: () => 0 },
} as const;

const BRANCH_A = asBranchId("branch-a");
const TARGET_CLONE = asBranchId("target-clone");

/** Every staged Person lands in one bucket, so `exactKey` proposes all pairs. */
const ONE_BUCKET = { block: () => "all" } as const;

describe.each(backendMatrix())(
  "identity pairing and the separation veto [$name]",
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

    async function makeStore(): Promise<Store<PairingGraph>> {
      const [store] = await createStoreWithSchema(
        pairingGraph,
        await makeBackend(),
        { history: true },
      );
      return store;
    }

    async function makeSimilarityStore(): Promise<Store<SimilarityGraph>> {
      const [store] = await createStoreWithSchema(
        similarityGraph,
        await makeBackend(),
        { history: true },
      );
      return store;
    }

    async function livePersonIds(
      store: Store<PairingGraph> | Store<SimilarityGraph>,
    ): Promise<readonly string[]> {
      const rows = await store.nodes.Person.find();
      return rows.map((row) => row.id as string).toSorted();
    }

    /**
     * T3 — a FORCED candidate edge whose endpoints the ledger holds apart is
     * refused at PLAN time.
     *
     * The target holds `alpha` and `beta` and separates them. A branch created
     * its own `beta` carrying `alpha`'s unique email, so the shared unique
     * value is a DEFINITIONAL claim that `beta` and `alpha` are one entity —
     * against a ledger that says they are not.
     */
    it("refuses a forced candidate edge whose endpoints are class-lifted different", async () => {
      const forkPoint = await makeStore();
      const target = unwrap(
        await branch(forkPoint, () => makeBackend(), { id: TARGET_CLONE }),
      ).store;
      await target.nodes.Person.create(
        { name: "Alpha", email: "alpha@example.test" },
        { id: "alpha" },
      );
      await target.nodes.Person.create(
        { name: "Beta", email: "beta@example.test" },
        { id: "beta" },
      );
      await target.identity.assertDifferent(
        { kind: "Person", id: "alpha" },
        { kind: "Person", id: "beta" },
      );

      const source = unwrap(
        await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
      );
      await source.store.nodes.Person.create(
        { name: "Beta", email: "alpha@example.test" },
        { id: "beta" },
      );

      const before = await livePersonIds(target);
      const result = await mergeIncremental({
        forkPoint,
        target,
        branches: [source],
        options: {
          branchOrder: [BRANCH_A],
          resolve: { Person: FORCED_ONLY_RESOLVE },
        },
      });

      if (isOk(result)) throw new Error("expected a separation refusal");
      expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
      // The load-bearing half: the code AND the phase. Without the
      // candidate-edge veto the merge reaches the commit and dies on the
      // separation relation's CHECK under a different code.
      expect(result.error.code).toBe(
        "GRAPH_MERGE_IDENTITY_SEPARATION_CONFLICT",
      );
      expect(result.error.details["a"]).toEqual({
        kind: "Person",
        id: "alpha",
      });
      expect(result.error.details["b"]).toEqual({ kind: "Person", id: "beta" });
      // The refusal names the assertion that separated them, not just that
      // something did.
      expect(result.error.details["assertionIds"]).toHaveLength(1);
      // The target is byte-unchanged: a plan-time refusal writes nothing.
      expect(await livePersonIds(target)).toEqual(before);
    });

    /**
     * T4 — a TRANSITIVE fusion is refused too.
     *
     * `alpha`–`gamma` and `gamma`–`beta` each clear the threshold while
     * `alpha`–`beta` does not, so NO candidate edge is separated and the
     * edge-level veto sees nothing. The cluster still fuses all three, and the
     * post-cluster assertion is what refuses it.
     */
    it("refuses a cluster that fuses a separated pair through a third node", async () => {
      const forkPoint = await makeSimilarityStore();
      const target = unwrap(
        await branch(forkPoint, () => makeBackend(), { id: TARGET_CLONE }),
      ).store;
      await target.nodes.Person.create(
        { name: "alpha", email: "alpha@example.test" },
        { id: "alpha" },
      );
      await target.nodes.Person.create(
        { name: "beta", email: "beta@example.test" },
        { id: "beta" },
      );
      await target.identity.assertDifferent(
        { kind: "Person", id: "alpha" },
        { kind: "Person", id: "beta" },
      );

      const source = unwrap(
        await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
      );
      await source.store.nodes.Person.create(
        { name: "gamma", email: "gamma@example.test" },
        { id: "gamma" },
      );

      const before = await livePersonIds(target);
      const result = await mergeIncremental({
        forkPoint,
        target,
        branches: [source],
        options: {
          branchOrder: [BRANCH_A],
          resolve: {
            Person: {
              ...ONE_BUCKET,
              threshold: 0.5,
              similarity: {
                kind: "custom",
                // `gamma` matches both, `alpha` and `beta` match neither —
                // a deterministic transitive bridge with no separated edge.
                score: (left, right) => {
                  const ids = [
                    left.id as string,
                    right.id as string,
                  ].toSorted();
                  return ids.includes("gamma") ? 1 : 0;
                },
              },
            },
          },
        },
      });

      if (isOk(result)) throw new Error("expected a separation refusal");
      expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
      expect(result.error.code).toBe(
        "GRAPH_MERGE_IDENTITY_SEPARATION_CONFLICT",
      );
      // The refusal names the separated PAIR, not the bridge that fused them.
      expect(result.error.details["cluster"]).toHaveLength(3);
      expect(await livePersonIds(target)).toEqual(before);
    });

    /**
     * T5 — `pairing: "definitional"` merges nodes created under different ids,
     * and `"off"` (the default) leaves them separate. One fixture, two option
     * values, two different graphs.
     */
    it("definitional pairing fuses nodes an assertSame spans; off leaves them apart", async () => {
      async function mergeWith(
        pairing: "off" | "definitional",
      ): Promise<readonly string[]> {
        const store = await makeStore();
        const source = unwrap(
          await branch(store, () => makeBackend(), { id: BRANCH_A }),
        );
        await source.store.nodes.Person.create(
          { name: "Ada", email: "a1@example.test" },
          { id: "a1" },
        );
        await source.store.nodes.Person.create(
          { name: "Ada", email: "b1@example.test" },
          { id: "b1" },
        );
        await source.store.identity.assertSame(
          { kind: "Person", id: "a1" },
          { kind: "Person", id: "b1" },
        );
        const result = await merge(store, [source], {
          branchOrder: [BRANCH_A],
          identity: { pairing },
        });
        if (isErr(result)) throw result.error;
        return livePersonIds(store);
      }

      expect(await mergeWith("off")).toEqual(["a1", "b1"]);
      expect(await mergeWith("definitional")).toEqual(["a1"]);
    });

    /**
     * A cross-kind `same` assertion cannot be expressed as a per-kind pairing
     * edge — `orderEndpoints` keys on `(kind, id)` and a source scope is built
     * per kind. It is reported as a typed conflict rather than skipped, so a
     * caller who stated `pairing` learns which of their assertions it could
     * not act on.
     */
    it("reports a cross-kind same assertion instead of silently skipping it", async () => {
      const store = await makeStore();
      const source = unwrap(
        await branch(store, () => makeBackend(), { id: BRANCH_A }),
      );
      await source.store.nodes.Person.create(
        { name: "Ada", email: "p@example.test" },
        { id: "p1" },
      );
      await source.store.nodes.Robot.create(
        { name: "Ada", email: "r@example.test" },
        { id: "r1" },
      );
      await source.store.identity.assertSame(
        { kind: "Person", id: "p1" },
        { kind: "Robot", id: "r1" },
      );

      const result = await merge(store, [source], {
        branchOrder: [BRANCH_A],
        identity: { pairing: "candidate" },
      });
      if (isErr(result)) throw result.error;
      const conflicts = result.data.identityConflicts.filter(
        (conflict) => conflict.kind === "assertion",
      );
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({
        kind: "assertion",
        reason: "cross-kind-pairing",
        a: { kind: "Person", id: "p1" },
        b: { kind: "Robot", id: "r1" },
      });
      // Reported, not fatal: both nodes still merge as themselves.
      expect(await livePersonIds(store)).toEqual(["p1"]);
    });

    /**
     * The veto is on even with `pairing` absent, because a `different`
     * assertion is an integrity fact and not a recall heuristic. Same fixture
     * as the transitive case, no `identity` option stated at all.
     */
    it("vetoes without any identity option stated", async () => {
      const forkPoint = await makeStore();
      const target = unwrap(
        await branch(forkPoint, () => makeBackend(), { id: TARGET_CLONE }),
      ).store;
      await target.nodes.Person.create(
        { name: "alpha", email: "alpha@example.test" },
        { id: "alpha" },
      );
      await target.nodes.Person.create(
        { name: "beta", email: "beta@example.test" },
        { id: "beta" },
      );
      await target.identity.assertDifferent(
        { kind: "Person", id: "alpha" },
        { kind: "Person", id: "beta" },
      );
      const source = unwrap(
        await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
      );
      await source.store.nodes.Person.create(
        { name: "beta", email: "alpha@example.test" },
        { id: "beta" },
      );

      const result = await mergeIncremental({
        forkPoint,
        target,
        branches: [source],
        options: {
          branchOrder: [BRANCH_A],
          resolve: { Person: FORCED_ONLY_RESOLVE },
        },
      });
      if (isOk(result)) throw new Error("expected a separation refusal");
      expect(result.error.code).toBe(
        "GRAPH_MERGE_IDENTITY_SEPARATION_CONFLICT",
      );
    });
  },
);
