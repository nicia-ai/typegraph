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
     * T3 — a DEFINITIONAL pairing that SURVIVES the base and diameter guards
     * is refused at PLAN time.
     *
     * Both branches recreate `alpha` and `beta`, which the TARGET already holds
     * apart, and one of them asserts they are the same entity. The two staged
     * assertions collide, and a policy that resolves the collision in favour
     * of `same` still cannot fuse them: resolving the collision changes what
     * the merge ASSERTS, not what the target currently HOLDS. Under
     * `pairing: "definitional"` the surviving assertion forces a fused edge
     * between two staged nodes — no base member is involved, so no guard
     * severs it and the cluster really would collapse two separated classes.
     */
    it("refuses a definitional pairing that survives the guards", async () => {
      const forkPoint = await makeSimilarityStore();
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
        { name: "Alpha", email: "alpha@example.test" },
        { id: "alpha" },
      );
      await source.store.nodes.Person.create(
        { name: "Beta", email: "beta@example.test" },
        { id: "beta" },
      );
      await source.store.identity.assertSame(
        { kind: "Person", id: "alpha" },
        { kind: "Person", id: "beta" },
      );

      const before = await livePersonIds(target);
      const result = await mergeIncremental({
        forkPoint,
        target,
        branches: [source],
        options: {
          branchOrder: [BRANCH_A],
          identity: {
            pairing: "definitional",
            onAssertionConflict: (conflict) => {
              const same = conflict.asserted.find(
                (staged) => staged.assertion.relation === "same",
              );
              return same === undefined ?
                  { kind: "unresolved" }
                : { kind: "assert", assertionId: same.assertion.id };
            },
          },
        },
      });

      if (isOk(result)) throw new Error("expected a separation refusal");
      expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
      // The load-bearing half: the code AND the phase. Without the veto the
      // merge reaches the commit and dies on the separation relation's CHECK
      // under a different code.
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
      // The EDGE-level diagnosis, not the cluster-level one: a surviving
      // definitional claim is refused naming the source that proposed it.
      expect(result.error.details["sources"]).toEqual([
        expect.objectContaining({ kind: "identity" }),
      ]);
      expect(result.error.details["cluster"]).toBeUndefined();
      // The target is byte-unchanged: a plan-time refusal writes nothing.
      expect(await livePersonIds(target)).toEqual(before);
    });

    /**
     * The counterpart, and the reason the definitional refusal runs AFTER the
     * guards: a forced BASE pairing between two committed entities is severed
     * by the component base guard, so it never fuses anything. Refusing it up
     * front would fail a merge that is harmless — this fixture merges cleanly
     * and leaves both entities, and their separation, intact.
     */
    it("does not refuse a forced base pairing the base guard already severed", async () => {
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
      // Shares `alpha`'s unique email, so a base source forces the pairing.
      await source.store.nodes.Person.create(
        { name: "Beta", email: "alpha@example.test" },
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

      if (isErr(result)) throw result.error;
      expect(result.data.resolutions).toEqual([]);
      expect(await livePersonIds(target)).toEqual(["alpha", "beta"]);
      expect(
        await target.identity.areDifferent(
          { kind: "Person", id: "alpha" },
          { kind: "Person", id: "beta" },
        ),
      ).toBe(true);
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
     * `pairing: "candidate"` is RECALL, not proof: the assertion proposes the
     * pair and the kind's own threshold still decides. The pair must therefore
     * travel the ordinary scored pipeline — blocking puts the two nodes in
     * different buckets, so no other source proposes them and the identity
     * source is the only recall path under test.
     */
    it("candidate pairing proposes a SCORED pair the kind's threshold still decides", async () => {
      async function mergeWith(
        identity: { pairing: "candidate" } | undefined,
        threshold: number,
      ): Promise<readonly string[]> {
        const store = await makeStore();
        const source = unwrap(
          await branch(store, () => makeBackend(), { id: BRANCH_A }),
        );
        await source.store.nodes.Person.create(
          { name: "Ada", email: "a2@example.test" },
          { id: "a2" },
        );
        await source.store.nodes.Person.create(
          { name: "Ada", email: "b2@example.test" },
          { id: "b2" },
        );
        await source.store.identity.assertSame(
          { kind: "Person", id: "a2" },
          { kind: "Person", id: "b2" },
        );
        const result = await merge(store, [source], {
          branchOrder: [BRANCH_A],
          resolve: {
            Person: {
              // One bucket per node: no other source can propose the pair.
              block: (node) => node.id as string,
              threshold,
              similarity: { kind: "custom", score: () => 0.6 },
            },
          },
          ...(identity === undefined ? {} : { identity }),
        });
        if (isErr(result)) throw result.error;
        return livePersonIds(store);
      }

      // Scored 0.6: above a 0.5 threshold the identity-recalled pair merges.
      expect(await mergeWith({ pairing: "candidate" }, 0.5)).toEqual(["a2"]);
      // Same recall, same score, higher bar — the threshold still decides.
      expect(await mergeWith({ pairing: "candidate" }, 0.9)).toEqual([
        "a2",
        "b2",
      ]);
      // Without the pairing option nothing proposes the pair at all.
      expect(await mergeWith(undefined, 0.5)).toEqual(["a2", "b2"]);
    });

    /**
     * `onProvenanceConflict: "refuse"` — for a caller whose source attribution
     * is a correctness invariant rather than a record. Only a cluster an
     * identity assertion FUSED is judged: two members contributed under
     * different source ids disagree, and the plan fails naming the canonical
     * entity and the contributions.
     */
    it("refuses an identity-paired entity whose members disagree on provenance", async () => {
      const store = await makeStore();
      const source = unwrap(
        await branch(store, () => makeBackend(), { id: BRANCH_A }),
      );
      await source.store.nodes.Person.create(
        { name: "Ada", email: "a3@example.test" },
        { id: "a3" },
      );
      await source.store.nodes.Person.create(
        { name: "Ada", email: "b3@example.test" },
        { id: "b3" },
      );
      await source.store.identity.assertSame(
        { kind: "Person", id: "a3" },
        { kind: "Person", id: "b3" },
      );

      const result = await merge(store, [source], {
        branchOrder: [BRANCH_A],
        identity: { pairing: "definitional", onProvenanceConflict: "refuse" },
      });
      if (isOk(result)) throw new Error("expected a provenance refusal");
      expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
      expect(result.error.code).toBe(
        "GRAPH_MERGE_IDENTITY_PROVENANCE_CONFLICT",
      );
      expect(result.error.details["conflict"]).toMatchObject({
        kind: "provenance",
        canonical: { kind: "Person", id: "a3" },
      });
      // Nothing was written: the refusal is a plan-time one.
      expect(await livePersonIds(store)).toEqual([]);

      // The DEFAULT keeps every contribution and merges the same fixture, so
      // the refusal is the policy's doing and not the pairing's.
      const keeping = await makeStore();
      const keepingSource = unwrap(
        await branch(keeping, () => makeBackend(), { id: BRANCH_A }),
      );
      await keepingSource.store.nodes.Person.create(
        { name: "Ada", email: "a3@example.test" },
        { id: "a3" },
      );
      await keepingSource.store.nodes.Person.create(
        { name: "Ada", email: "b3@example.test" },
        { id: "b3" },
      );
      await keepingSource.store.identity.assertSame(
        { kind: "Person", id: "a3" },
        { kind: "Person", id: "b3" },
      );
      const kept = await merge(keeping, [keepingSource], {
        branchOrder: [BRANCH_A],
        identity: { pairing: "definitional" },
      });
      if (isErr(kept)) throw kept.error;
      expect(await livePersonIds(keeping)).toEqual(["a3"]);
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
     * A `same` assertion whose endpoints are not both staged new nodes of the
     * kind cannot be expressed as a pairing edge either — candidate generation
     * proposes over the nodes in scope. It is reported for the same reason the
     * cross-kind case is: a stated `pairing` that cannot be applied must be
     * visibly refused, never silently skipped.
     */
    it("reports a same assertion whose endpoint is not a staged new node", async () => {
      const store = await makeStore();
      // Committed on the TARGET before the branch forks, so it is base truth
      // and never a staged new node.
      await store.nodes.Person.create(
        { name: "Ada", email: "committed@example.test" },
        { id: "committed" },
      );
      const source = unwrap(
        await branch(store, () => makeBackend(), { id: BRANCH_A }),
      );
      await source.store.nodes.Person.create(
        { name: "Ada", email: "fresh@example.test" },
        { id: "fresh" },
      );
      await source.store.identity.assertSame(
        { kind: "Person", id: "committed" },
        { kind: "Person", id: "fresh" },
      );

      const result = await merge(store, [source], {
        branchOrder: [BRANCH_A],
        identity: { pairing: "definitional" },
      });
      if (isErr(result)) throw result.error;
      expect(
        result.data.identityConflicts.filter(
          (conflict) =>
            conflict.kind === "assertion" &&
            conflict.reason === "out-of-scope-pairing",
        ),
      ).toMatchObject([
        {
          a: { kind: "Person", id: "committed" },
          b: { kind: "Person", id: "fresh" },
        },
      ]);
      // Reported, not fatal, and nothing was fused.
      expect(await livePersonIds(store)).toEqual(["committed", "fresh"]);
    });

    /**
     * The veto is on even with `pairing` absent, because a `different`
     * assertion is an integrity fact and not a recall heuristic. A SCORED
     * match is recall, so the ledger's veto drops the proposal, reports it,
     * and the merge continues — the plan is still applicable.
     */
    it("drops and reports a scored match the ledger holds apart, with no identity option stated", async () => {
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
        { name: "delta", email: "delta@example.test" },
        { id: "delta" },
      );

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
                // Only the separated pair scores: nothing else may fuse, so
                // the drop is observable on its own.
                score: (left, right) => {
                  const ids = [
                    left.id as string,
                    right.id as string,
                  ].toSorted();
                  return ids[0] === "alpha" && ids[1] === "beta" ? 1 : 0;
                },
              },
            },
          },
        },
      });

      if (isErr(result)) throw result.error;
      const separations = result.data.identityConflicts.filter(
        (conflict) => conflict.kind === "separation",
      );
      expect(separations).toHaveLength(1);
      expect(separations[0]).toMatchObject({
        kind: "separation",
        a: { kind: "Person", id: "alpha" },
        b: { kind: "Person", id: "beta" },
      });
      expect(separations[0]?.assertionIds).toHaveLength(1);
      // Reported, not fatal: the merge lands and the separation stands.
      expect(await livePersonIds(target)).toEqual(["alpha", "beta", "delta"]);
      expect(
        await target.identity.areDifferent(
          { kind: "Person", id: "alpha" },
          { kind: "Person", id: "beta" },
        ),
      ).toBe(true);
    });
  },
);
