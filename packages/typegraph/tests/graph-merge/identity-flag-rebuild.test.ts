/**
 * `identity.onEdgeConflict: "flag"` and `identity.onUniquenessConflict: "flag"`:
 * the one deterministic plan rebuild the two policies share, the `"edge"` and
 * `"uniqueness"` arms of `IdentityUnresolvedConflict` they report, and the
 * store-owned uniqueness decision the planner probes through.
 *
 * Each case runs the SAME fixture under the default policy and under `"flag"`,
 * so the default is pinned byte-for-byte (the fold / the apply-time refusal)
 * beside the new behavior (the dropped pairing, the report, an applicable plan).
 *
 * Runs on every backend in the merge matrix: the uniqueness probe is the
 * store's own batched claim read, which is backend-specific code.
 */
import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  subClassOf,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import {
  applyMergePlan,
  merge,
  planMerge,
  planMergeIncremental,
} from "../../src/graph-merge/merge";
import { parseMergePlanArtifact } from "../../src/graph-merge/plan-wire";
import { isErr, isOk, unwrap } from "../../src/graph-merge/result";
import {
  asBranchId,
  type IdentityReconciliationOptions,
  type IdentityUnresolvedConflict,
  type MergeReport,
} from "../../src/graph-merge/types";
import { requireDefined } from "../../src/utils/presence";
import { backendMatrix } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const worksAt = defineEdge("worksAt", {
  schema: z.object({ role: z.string() }),
});

/** Person has NO unique constraint: an identity assertion is the only pairing. */
const edgeGraph = defineGraph({
  id: "identity_flag_rebuild_edges",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: { worksAt: { type: worksAt, from: [Person], to: [Company] } },
  identity: { sameIdAcrossKinds: "ignore" },
});
type EdgeGraph = typeof edgeGraph;

const NamedPerson = defineNode("NamedPerson", {
  schema: z.object({
    name: z.string(),
    first: z.string().optional(),
    last: z.string().optional(),
  }),
});
const NamedEmployee = defineNode("NamedEmployee", {
  schema: z.object({
    name: z.string(),
    first: z.string().optional(),
    last: z.string().optional(),
  }),
});

/**
 * A compound `(first, last)` unique key that applies only once `last` is set,
 * BINARY collation, scoped across the `NamedEmployee` subclass. A fused entity
 * can therefore carry a key neither member carried alone — `first` from one
 * member and `last` from the other — which is exactly the collision an
 * identity pairing induces.
 */
const FULL_NAME_CONSTRAINT = {
  name: "full_name",
  fields: ["first", "last"],
  scope: "kindWithSubClasses",
  collation: "binary",
  where: (fields: Readonly<Record<string, { isNotNull(): unknown }>>) =>
    requireDefined(fields["last"]).isNotNull(),
} as const;

const uniqueGraph = defineGraph({
  id: "identity_flag_rebuild_unique",
  nodes: {
    NamedPerson: {
      type: NamedPerson,
      unique: [FULL_NAME_CONSTRAINT as never],
    },
    NamedEmployee: {
      type: NamedEmployee,
      unique: [FULL_NAME_CONSTRAINT as never],
    },
  },
  edges: {},
  ontology: [subClassOf(NamedEmployee, NamedPerson)],
  identity: { sameIdAcrossKinds: "ignore" },
});
type UniqueGraph = typeof uniqueGraph;

const NamedManager = defineNode("NamedManager", {
  schema: z.object({
    name: z.string(),
    first: z.string().optional(),
    last: z.string().optional(),
  }),
});

/**
 * The compound key declared on every level of a three-deep chain, each
 * scoped to its OWN kind (separate namespaces): the kind a write lands under
 * decides which namespace it claims in, so a counterfactual that skipped the
 * retype would probe the wrong one.
 */
const KIND_SCOPED_FULL_NAME = {
  ...FULL_NAME_CONSTRAINT,
  scope: "kind",
} as const;
const retypeGraph = defineGraph({
  id: "identity_flag_rebuild_retype",
  nodes: {
    NamedPerson: {
      type: NamedPerson,
      unique: [KIND_SCOPED_FULL_NAME as never],
    },
    NamedEmployee: {
      type: NamedEmployee,
      unique: [KIND_SCOPED_FULL_NAME as never],
    },
    NamedManager: {
      type: NamedManager,
      unique: [KIND_SCOPED_FULL_NAME as never],
    },
  },
  edges: {},
  ontology: [
    subClassOf(NamedEmployee, NamedPerson),
    subClassOf(NamedManager, NamedEmployee),
  ],
  identity: { sameIdAcrossKinds: "ignore" },
});
type RetypeGraph = typeof retypeGraph;

const EmailedPerson = defineNode("NamedPerson", {
  schema: z.object({
    name: z.string(),
    email: z.string().optional(),
    first: z.string().optional(),
    last: z.string().optional(),
  }),
});

/** `uniqueGraph` plus a second, kind-scoped key on `email` for the base-unique source. */
const modifiedGraph = defineGraph({
  id: "identity_flag_rebuild_modified",
  nodes: {
    NamedPerson: {
      type: EmailedPerson,
      unique: [
        FULL_NAME_CONSTRAINT as never,
        {
          name: "person_email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
          where: (fields: Readonly<Record<string, { isNotNull(): unknown }>>) =>
            requireDefined(fields["email"]).isNotNull(),
        } as never,
      ],
    },
    NamedEmployee: {
      type: NamedEmployee,
      unique: [FULL_NAME_CONSTRAINT as never],
    },
  },
  edges: {},
  ontology: [subClassOf(NamedEmployee, EmailedPerson)],
  identity: { sameIdAcrossKinds: "ignore" },
});
type ModifiedGraph = typeof modifiedGraph;

const BRANCH_A = asBranchId("branch-a");
const BRANCH_B = asBranchId("branch-b");
const TARGET_CLONE = asBranchId("target-clone");

/** Every staged Person lands in one bucket, so `exactKey` proposes all pairs. */
const ONE_BUCKET = { block: () => "all" } as const;

function conflictsOfKind<K extends IdentityUnresolvedConflict["kind"]>(
  report: MergeReport<never>,
  kind: K,
): readonly Extract<IdentityUnresolvedConflict, Readonly<{ kind: K }>>[] {
  return report.identityConflicts.filter(
    (
      conflict,
    ): conflict is Extract<IdentityUnresolvedConflict, Readonly<{ kind: K }>> =>
      conflict.kind === kind,
  );
}

describe.each(backendMatrix())(
  "identity flag rebuild — edge and uniqueness conflicts [$name]",
  (entry) => {
    let cleanups: (() => Promise<void>)[];

    beforeEach(() => {
      cleanups = [];
    });

    afterEach(async () => {
      for (const cleanup of cleanups.toReversed()) {
        await cleanup();
      }
    });

    async function makeBackend(): Promise<GraphBackend> {
      const fixture = await entry.make();
      cleanups.push(fixture.cleanup);
      return fixture.backend;
    }

    /**
     * The edge fixture: the base holds company `x`; branch A creates `a1` and
     * `b1`, each `worksAt` `x` under its own edge id, and asserts the two are
     * one person. Fusing them repoints both edges onto one `(a1, worksAt, x)`
     * slot — two distinct pre-repoint relationships collapsing onto one edge.
     */
    async function edgeFixture(): Promise<
      Readonly<{
        base: Store<EdgeGraph>;
        source: Awaited<ReturnType<typeof branch<EdgeGraph>>> extends infer R ?
          R extends { success: true; data: infer D } ?
            D
          : never
        : never;
        edgeIds: readonly string[];
        assertionId: string;
      }>
    > {
      const [base] = await createStoreWithSchema(
        edgeGraph,
        await makeBackend(),
        { history: true },
      );
      await base.nodes.Company.create({ name: "X" }, { id: "x" });
      const source = unwrap(
        await branch(base, () => makeBackend(), { id: BRANCH_A }),
      );
      await source.store.nodes.Person.create({ name: "Ada" }, { id: "a1" });
      await source.store.nodes.Person.create({ name: "Ada L." }, { id: "b1" });
      const first = await source.store.edges.worksAt.create(
        { kind: "Person", id: "a1" },
        { kind: "Company", id: "x" },
        { role: "engineer" },
        { id: "edge-a1" },
      );
      const second = await source.store.edges.worksAt.create(
        { kind: "Person", id: "b1" },
        { kind: "Company", id: "x" },
        { role: "engineer" },
        { id: "edge-b1" },
      );
      const assertion = await source.store.identity.assertSame(
        { kind: "Person", id: "a1" },
        { kind: "Person", id: "b1" },
      );
      return {
        base,
        source,
        edgeIds: [first.id as string, second.id as string].toSorted(),
        assertionId: assertion.assertion.id,
      };
    }

    it("repoint (default) folds the two relationships onto one edge; flag keeps both and reports the pairing it dropped", async () => {
      const folded = await edgeFixture();
      const foldedResult = await merge(folded.base, [folded.source], {
        branchOrder: [BRANCH_A],
        identity: { pairing: "definitional" },
      });
      if (isErr(foldedResult)) throw foldedResult.error;
      expect(
        (await folded.base.nodes.Person.find()).map((row) => row.id),
      ).toEqual(["a1"]);
      expect(await folded.base.edges.worksAt.find()).toHaveLength(1);
      expect(conflictsOfKind(foldedResult.data as never, "edge")).toEqual([]);

      const flagged = await edgeFixture();
      const flaggedResult = await merge(flagged.base, [flagged.source], {
        branchOrder: [BRANCH_A],
        identity: { pairing: "definitional", onEdgeConflict: "flag" },
      });
      if (isErr(flaggedResult)) throw flaggedResult.error;
      const conflicts = conflictsOfKind(flaggedResult.data as never, "edge");
      console.info(`[${entry.name}] edge conflicts:`, conflicts);
      expect(conflicts).toEqual([
        {
          kind: "edge",
          edgeKind: "worksAt",
          a: { kind: "Person", id: "a1" },
          b: { kind: "Person", id: "b1" },
          canonical: { kind: "Person", id: "a1" },
          side: "from",
          edgeIds: flagged.edgeIds,
          assertionIds: [flagged.assertionId],
          branches: [BRANCH_A],
        },
      ]);
      // The pairing was dropped from candidate generation, so both rows and
      // both relationships land as staged …
      expect(
        (await flagged.base.nodes.Person.find())
          .map((row) => row.id as string)
          .toSorted(),
      ).toEqual(["a1", "b1"]);
      expect(
        (await flagged.base.edges.worksAt.find())
          .map((edge) => edge.id as string)
          .toSorted(),
      ).toEqual(flagged.edgeIds);
      // … while the identity truth itself is still asserted: the two rows share
      // one identity class, they are simply not consolidated into one row.
      expect(
        await flagged.base.identity.areSame(
          { kind: "Person", id: "a1" },
          { kind: "Person", id: "b1" },
        ),
      ).toBe(true);
    });
    // MUTATION CHECK: in `pairingInducedEdgeConflicts` (src/graph-merge/merge.ts)
    // return `[]` unconditionally — the flag case above then folds exactly like
    // the default and the `toEqual([...])` on the conflicts fails on `[]`.

    it("carries the edge arm through the durable plan artifact and the applied report", async () => {
      const fixture = await edgeFixture();
      const artifact = unwrap(
        await planMerge(fixture.base, [fixture.source], {
          branchOrder: [BRANCH_A],
          identity: { pairing: "definitional", onEdgeConflict: "flag" },
        }),
      );
      // The strict wire schema admits the arm — a serialized plan round-trips.
      const reparsed = parseMergePlanArtifact(
        JSON.parse(JSON.stringify(artifact)),
      );
      if (!reparsed.success) {
        throw new Error(
          `plan did not reparse: ${JSON.stringify(reparsed.error)}`,
        );
      }
      expect(reparsed.artifact.review.identityConflicts).toEqual([
        expect.objectContaining({ kind: "edge", edgeKind: "worksAt" }),
      ]);
      const applied = unwrap(await applyMergePlan(fixture.base, artifact));
      expect(conflictsOfKind(applied as never, "edge")).toHaveLength(1);
      expect(
        (await fixture.base.edges.worksAt.find())
          .map((edge) => edge.id as string)
          .toSorted(),
      ).toEqual(fixture.edgeIds);
    });

    it("does not blame the pairing for a collapse similarity would have produced anyway", async () => {
      const fixture = await edgeFixture();
      const result = await merge(fixture.base, [fixture.source], {
        branchOrder: [BRANCH_A],
        resolve: {
          Person: {
            ...ONE_BUCKET,
            threshold: 0.5,
            // Every staged pair scores 1: similarity fuses a1 and b1 with or
            // without the assertion.
            similarity: { kind: "custom", score: () => 1 },
          },
        },
        identity: { pairing: "definitional", onEdgeConflict: "flag" },
      });
      if (isErr(result)) throw result.error;
      // The rebuild without the pairing fused them again, so the collapse is the
      // merge's ordinary repoint: one row, one edge, nothing reported.
      expect(conflictsOfKind(result.data as never, "edge")).toEqual([]);
      expect(
        (await fixture.base.nodes.Person.find()).map((row) => row.id),
      ).toEqual(["a1"]);
      expect(await fixture.base.edges.worksAt.find()).toHaveLength(1);
    });
    // MUTATION CHECK: make `stillFusedWithoutPairing` return `false` for the
    // `"edge"` arm — the similarity-fused collapse above is then reported as a
    // pairing-induced conflict and `toEqual([])` fails.

    /**
     * The uniqueness fixture: the base holds a `NamedEmployee` — a SUBCLASS row —
     * carrying the full name `Ada Lovelace`. Branch A creates two `NamedPerson`
     * rows, one carrying only `first: "Ada"` (the constraint does not apply to
     * it: `last` is null) and one carrying only `last`, and asserts they are
     * one person. The fused entity carries BOTH fields, so its key equals the
     * employee's under the `kindWithSubClasses` scope — a key neither member
     * had alone.
     */
    async function uniqueFixture(stagedLast: string): Promise<
      Readonly<{
        base: Store<UniqueGraph>;
        source: Awaited<ReturnType<typeof branch<UniqueGraph>>> extends (
          infer R
        ) ?
          R extends { success: true; data: infer D } ?
            D
          : never
        : never;
        assertionId: string;
      }>
    > {
      const [base] = await createStoreWithSchema(
        uniqueGraph,
        await makeBackend(),
        { history: true },
      );
      await base.nodes.NamedEmployee.create(
        { name: "Ada Lovelace", first: "Ada", last: "Lovelace" },
        { id: "emp" },
      );
      const source = unwrap(
        await branch(base, () => makeBackend(), { id: BRANCH_A }),
      );
      await source.store.nodes.NamedPerson.create(
        { name: "Ada", first: "Ada" },
        { id: "a1" },
      );
      await source.store.nodes.NamedPerson.create(
        { name: "Lovelace", last: stagedLast },
        { id: "b1" },
      );
      const assertion = await source.store.identity.assertSame(
        { kind: "NamedPerson", id: "a1" },
        { kind: "NamedPerson", id: "b1" },
      );
      return { base, source, assertionId: assertion.assertion.id };
    }

    async function mergeUnique(
      fixture: Awaited<ReturnType<typeof uniqueFixture>>,
      identity: IdentityReconciliationOptions,
    ) {
      return merge(fixture.base, [fixture.source], {
        branchOrder: [BRANCH_A],
        identity,
      });
    }

    it("refuse (default) fails the fused write at apply; flag reports the collision, drops the pairing and applies", async () => {
      const refused = await uniqueFixture("Lovelace");
      const refusedResult = await mergeUnique(refused, {
        pairing: "definitional",
      });
      if (isOk(refusedResult)) throw new Error("expected a constraint refusal");
      // The commit's own resolved-write-set refusal, unchanged: the store's
      // constraint decision names the employee row the fused entity collides with.
      expect(refusedResult.error.code).toBe("GRAPH_MERGE_CONSTRAINT_CONFLICT");
      expect(refusedResult.error.details["constraintName"]).toBe("full_name");
      expect(refusedResult.error.details["existingId"]).toBe("emp");
      expect(
        (await refused.base.nodes.NamedPerson.find()).map((row) => row.id),
      ).toEqual([]);

      const flagged = await uniqueFixture("Lovelace");
      const flaggedResult = await mergeUnique(flagged, {
        pairing: "definitional",
        onUniquenessConflict: "flag",
      });
      if (isErr(flaggedResult)) throw flaggedResult.error;
      const conflicts = conflictsOfKind(
        flaggedResult.data as never,
        "uniqueness",
      );
      console.info(`[${entry.name}] uniqueness conflicts:`, conflicts);
      expect(conflicts).toEqual([
        {
          kind: "uniqueness",
          constraintName: "full_name",
          fields: ["first", "last"],
          canonical: { kind: "NamedPerson", id: "a1" },
          // The owner's OWN kind — the subclass row the scope reached — and
          // the fused write the store refused for it.
          owner: { kind: "NamedEmployee", id: "emp" },
          loser: { kind: "NamedPerson", id: "a1" },
          members: [
            { kind: "NamedPerson", id: "a1" },
            { kind: "NamedPerson", id: "b1" },
          ],
          assertionIds: [flagged.assertionId],
          branches: [BRANCH_A],
        },
      ]);
      // Both rows land separately (each carries a legal key on its own), the
      // constraint itself was never relaxed, and the identity truth still holds.
      expect(
        (await flagged.base.nodes.NamedPerson.find())
          .map((row) => row.id as string)
          .toSorted(),
      ).toEqual(["a1", "b1"]);
      expect(
        await flagged.base.identity.areSame(
          { kind: "NamedPerson", id: "a1" },
          { kind: "NamedPerson", id: "b1" },
        ),
      ).toBe(true);
      const violations = await flagged.base.verifyConstraintFences();
      expect(violations).toEqual([]);
    });
    // MUTATION CHECK: in `pairingInducedUniquenessConflicts` (src/graph-merge/
    // merge.ts) return `[]` before the probe — the flag case then behaves like
    // the default and the merge is refused instead of reporting.

    it("agrees with the write path's collation: a key that differs only by case does not collide under binary", async () => {
      const fixture = await uniqueFixture("lovelace");
      const result = await mergeUnique(fixture, {
        pairing: "definitional",
        onUniquenessConflict: "flag",
      });
      if (isErr(result)) throw result.error;
      // `Ada lovelace` ≠ `Ada Lovelace` under `binary`, exactly as the commit's
      // own refusal would have judged it — so the pairing stands and fuses.
      expect(conflictsOfKind(result.data as never, "uniqueness")).toEqual([]);
      expect(
        (await fixture.base.nodes.NamedPerson.find()).map((row) => row.id),
      ).toEqual(["a1"]);
    });
    // MUTATION CHECK: change `FULL_NAME_CONSTRAINT.collation` to
    // "caseInsensitive" — the write path and the probe now BOTH see the
    // collision, the pairing is dropped and `toEqual([])` fails. (Spelling the
    // key in the planner would have left this test green while the write path
    // disagreed; the probe reaches the store's own key computation.)

    /**
     * A collision a MEMBER carries on its own is not the pairing's doing: `b1`
     * alone claims the full key `e1` also claims, and the assertion merely
     * fused `a1` (no key) onto it. `"flag"` must leave that collision to the
     * commit's refusal — exactly the default's outcome — and drop nothing,
     * rather than blame the pairing and hand back a plan that cannot apply.
     */
    it("leaves a member-owned collision to the commit's refusal instead of blaming the pairing", async () => {
      const [base] = await createStoreWithSchema(
        uniqueGraph,
        await makeBackend(),
        { history: true },
      );
      const sourceA = unwrap(
        await branch(base, () => makeBackend(), { id: BRANCH_A }),
      );
      await sourceA.store.nodes.NamedPerson.create(
        { name: "Ada", first: "Ada" },
        { id: "a1" },
      );
      await sourceA.store.nodes.NamedPerson.create(
        { name: "Ada Lovelace", first: "Ada", last: "Lovelace" },
        { id: "b1" },
      );
      await sourceA.store.identity.assertSame(
        { kind: "NamedPerson", id: "a1" },
        { kind: "NamedPerson", id: "b1" },
      );
      const sourceB = unwrap(
        await branch(base, () => makeBackend(), { id: BRANCH_B }),
      );
      await sourceB.store.nodes.NamedPerson.create(
        { name: "Ada Lovelace", first: "Ada", last: "Lovelace" },
        { id: "e1" },
      );

      // The plan blames nothing: no pairing is dropped, no conflict reported …
      const artifact = unwrap(
        await planMerge(base, [sourceA, sourceB], {
          branchOrder: [BRANCH_A, BRANCH_B],
          identity: { pairing: "definitional", onUniquenessConflict: "flag" },
        }),
      );
      console.info(
        `[${entry.name}] member-owned review:`,
        artifact.review.identityConflicts,
      );
      expect(artifact.review.identityConflicts ?? []).toEqual([]);
      // … and the fused write meets the commit's own refusal, exactly as the
      // default policy's would.
      const applied = await applyMergePlan(base, artifact);
      if (isOk(applied)) throw new Error("expected a constraint refusal");
      expect(applied.error.code).toBe("GRAPH_MERGE_CONSTRAINT_CONFLICT");
      expect(applied.error.details["constraintName"]).toBe("full_name");
      const byDefault = await merge(base, [sourceA, sourceB], {
        branchOrder: [BRANCH_A, BRANCH_B],
        identity: { pairing: "definitional" },
      });
      if (isOk(byDefault)) throw new Error("expected a constraint refusal");
      expect(byDefault.error.code).toBe("GRAPH_MERGE_CONSTRAINT_CONFLICT");
      expect(await base.nodes.NamedPerson.find()).toEqual([]);
    });
    // MUTATION CHECK: in `pairingInducedUniquenessConflicts` treat every party
    // finding as induced (skip the counterfactual, or never record a
    // member-owned claim) — the plan above then reports a `uniqueness`
    // conflict blaming the pairing and `toEqual([])` fails, while applying it
    // still refuses `b1` vs `e1`: a dropped pairing that bought nothing.

    /**
     * Two pairings, two full keys: each branch stages a row carrying the whole
     * key on its own plus a keyless partner it asserts `same`. Neither
     * collision is the pairing's — the two key-carrying members collide with
     * each other unfused — so `"flag"` drops nothing and refuses exactly as the
     * default does, instead of dropping one pairing, rebuilding, meeting the
     * other, and failing the rebuild's invariant.
     */
    it("refuses two member-owned collisions the same way the default does, without a rebuild invariant failure", async () => {
      const [base] = await createStoreWithSchema(
        uniqueGraph,
        await makeBackend(),
        { history: true },
      );
      const sourceA = unwrap(
        await branch(base, () => makeBackend(), { id: BRANCH_A }),
      );
      await sourceA.store.nodes.NamedPerson.create(
        { name: "Ada Lovelace", first: "Ada", last: "Lovelace" },
        { id: "a-full" },
      );
      await sourceA.store.nodes.NamedPerson.create(
        { name: "Ada" },
        { id: "a-partner" },
      );
      await sourceA.store.identity.assertSame(
        { kind: "NamedPerson", id: "a-full" },
        { kind: "NamedPerson", id: "a-partner" },
      );
      const sourceB = unwrap(
        await branch(base, () => makeBackend(), { id: BRANCH_B }),
      );
      await sourceB.store.nodes.NamedPerson.create(
        { name: "Ada Lovelace", first: "Ada", last: "Lovelace" },
        { id: "b-full" },
      );
      await sourceB.store.nodes.NamedPerson.create(
        { name: "Ada" },
        { id: "b-partner" },
      );
      await sourceB.store.identity.assertSame(
        { kind: "NamedPerson", id: "b-full" },
        { kind: "NamedPerson", id: "b-partner" },
      );

      for (const identity of [
        { pairing: "definitional" as const },
        {
          pairing: "definitional" as const,
          onUniquenessConflict: "flag" as const,
        },
      ]) {
        const result = await merge(base, [sourceA, sourceB], {
          branchOrder: [BRANCH_A, BRANCH_B],
          identity,
        });
        if (isOk(result)) throw new Error("expected a constraint refusal");
        console.info(
          `[${entry.name}] two pairings:`,
          identity,
          result.error.code,
        );
        expect(result.error.code).toBe("GRAPH_MERGE_CONSTRAINT_CONFLICT");
        expect(result.error.message).not.toContain("did not converge");
      }
    });
    // MUTATION CHECK: decide induction from the fused probe alone (never
    // record a member-owned claim) AND blame only the claimant's cluster
    // (`[claimant ?? holder]` in `clustersOf`) — the flag run drops one
    // pairing, the rebuild surfaces the other, and the merge fails with the
    // "did not converge" GRAPH_MERGE_ERROR instead of the constraint refusal.

    /**
     * A collision only the SECOND pass can see. Pairing A fuses `a1` (first
     * only) with `a2` (`Grace Hopper`); the union keeps the survivor's `first`,
     * so the fused key is `Ada Hopper` — which the target's `emp` holds — while
     * `a2`'s own key `Grace Hopper` is discarded by the union. Pairing C fuses
     * `c1` (first `Grace`) with `c2` (`Zed Hopper`) into `Grace Hopper`. Pass
     * one sees only A's collision (C collides with nothing the fused set
     * writes) and drops A; splitting A puts `a2`'s own `Grace Hopper` back,
     * which now collides with C's fused write. Pass two attributes that to C
     * (no member of C claims `Grace Hopper` alone) and drops it; pass three
     * finds nothing. Every pass's conflict is carried on the report.
     */
    it("iterates induction and rebuild to a fixpoint when a split member's own key meets a second induced pairing", async () => {
      const [base] = await createStoreWithSchema(
        uniqueGraph,
        await makeBackend(),
        { history: true },
      );
      await base.nodes.NamedEmployee.create(
        { name: "Ada Hopper", first: "Ada", last: "Hopper" },
        { id: "emp" },
      );
      const source = unwrap(
        await branch(base, () => makeBackend(), { id: BRANCH_A }),
      );
      await source.store.nodes.NamedPerson.create(
        { name: "Ada", first: "Ada" },
        { id: "a1" },
      );
      await source.store.nodes.NamedPerson.create(
        { name: "Grace Hopper", first: "Grace", last: "Hopper" },
        { id: "a2" },
      );
      await source.store.nodes.NamedPerson.create(
        { name: "Grace", first: "Grace" },
        { id: "c1" },
      );
      await source.store.nodes.NamedPerson.create(
        { name: "Zed Hopper", first: "Zed", last: "Hopper" },
        { id: "c2" },
      );
      const pairA = await source.store.identity.assertSame(
        { kind: "NamedPerson", id: "a1" },
        { kind: "NamedPerson", id: "a2" },
      );
      const pairC = await source.store.identity.assertSame(
        { kind: "NamedPerson", id: "c1" },
        { kind: "NamedPerson", id: "c2" },
      );

      const result = await merge(base, [source], {
        branchOrder: [BRANCH_A],
        identity: { pairing: "definitional", onUniquenessConflict: "flag" },
      });
      if (isErr(result)) throw result.error;
      const conflicts = conflictsOfKind(result.data as never, "uniqueness");
      console.info(`[${entry.name}] fixpoint conflicts:`, conflicts);
      expect(
        conflicts.map((conflict) => ({
          canonical: conflict.canonical.id,
          owner: conflict.owner.id,
          assertionIds: conflict.assertionIds,
        })),
      ).toEqual([
        // Pass one: A's fused `Ada Hopper` against the employee row.
        { canonical: "a1", owner: "emp", assertionIds: [pairA.assertion.id] },
        // Pass two: C's fused `Grace Hopper` against `a2`'s own write.
        { canonical: "c1", owner: "a2", assertionIds: [pairC.assertion.id] },
      ]);
      // Both pairings dropped, every row lands on its own, nothing collides.
      expect(
        (await base.nodes.NamedPerson.find())
          .map((row) => row.id as string)
          .toSorted(),
      ).toEqual(["a1", "a2", "c1", "c2"]);
      expect(await base.verifyConstraintFences()).toEqual([]);
    });
    // MUTATION CHECK: force a single pass in `resolvePairingInducedConflicts`
    // (`break` after the first rebuild, throwing the invariant error if the
    // rebuilt plan still reports an induced conflict) — pass two's collision
    // is then the "did not converge" GRAPH_MERGE_ERROR and `throw result.error`
    // fails this test.

    /**
     * A cluster whose SIMILARITY edges already connect every member is not
     * identity-induced, whatever redundant `same` it also carries: `a1`–`b1`–`c1`
     * chain by score, `same(a1, c1)` adds nothing, and the fused key collides
     * with the employee row. `"flag"` has nothing to drop here and must hand
     * the collision to the commit's refusal — never a "names no further
     * pairing" invariant error.
     */
    it("leaves a similarity-fused collision alone when the only identity edge is redundant", async () => {
      const [base] = await createStoreWithSchema(
        uniqueGraph,
        await makeBackend(),
        { history: true },
      );
      await base.nodes.NamedEmployee.create(
        { name: "Ada Lovelace", first: "Ada", last: "Lovelace" },
        { id: "emp" },
      );
      const source = unwrap(
        await branch(base, () => makeBackend(), { id: BRANCH_A }),
      );
      await source.store.nodes.NamedPerson.create(
        { name: "Ada", first: "Ada" },
        { id: "a1" },
      );
      await source.store.nodes.NamedPerson.create(
        { name: "B", last: "Lovelace" },
        { id: "b1" },
      );
      await source.store.nodes.NamedPerson.create({ name: "C" }, { id: "c1" });
      await source.store.identity.assertSame(
        { kind: "NamedPerson", id: "a1" },
        { kind: "NamedPerson", id: "c1" },
      );
      // a1–b1 and b1–c1 score; a1–c1 does not, so only the assertion relates
      // them directly — and the chain already fuses them.
      const chain = {
        NamedPerson: {
          ...ONE_BUCKET,
          threshold: 0.5,
          similarity: {
            kind: "custom" as const,
            score: (left: { id: string }, right: { id: string }) =>
              [left.id, right.id].includes("b1") ? 1 : 0,
          },
        },
      };
      const artifact = unwrap(
        await planMerge(base, [source], {
          branchOrder: [BRANCH_A],
          resolve: chain,
          identity: { pairing: "definitional", onUniquenessConflict: "flag" },
        }),
      );
      expect(artifact.review.identityConflicts ?? []).toEqual([]);
      const applied = await applyMergePlan(base, artifact);
      if (isOk(applied)) throw new Error("expected a constraint refusal");
      expect(applied.error.code).toBe("GRAPH_MERGE_CONSTRAINT_CONFLICT");
      expect(applied.error.message).not.toContain("did not converge");
      const byDefault = await merge(base, [source], {
        branchOrder: [BRANCH_A],
        resolve: chain,
        identity: { pairing: "definitional" },
      });
      if (isOk(byDefault)) throw new Error("expected a constraint refusal");
      expect(byDefault.error.code).toBe("GRAPH_MERGE_CONSTRAINT_CONFLICT");
    });
    // MUTATION CHECK: two guards cover this shape and BOTH must go to reach the
    // old failure — in `pairingInducedUniquenessConflicts` remove the
    // empty-`assertionIds` guard AND make `unfusedWrites` singleton member
    // writes instead of per-component writes — the plan then reports a
    // conflict naming no assertion and the merge fails with the "names no
    // further pairing to drop" GRAPH_MERGE_ERROR instead of the constraint
    // refusal.

    /**
     * A MODIFIED base member's own write carries the fork's edit: `m` (a
     * fork-point row the target still holds) gains `last: "Lovelace"` in the
     * branch, which alone completes the key the target's newer employee row
     * holds. The branch also stages `n1` (matched onto `m` by the base-unique
     * `email` source) and `n2`, asserted `same` with `n1`. The collision is
     * `m`'s own, so the pairing is not to blame — which the counterfactual can
     * only see if the modification is folded into `m`'s unfused write.
     */
    it("folds a modified base member's own write into the counterfactual", async () => {
      const [forkPoint] = await createStoreWithSchema(
        modifiedGraph,
        await makeBackend(),
        { history: true },
      );
      await forkPoint.nodes.NamedPerson.create(
        { name: "M", first: "Ada", email: "m@example.test" },
        { id: "m" },
      );
      const target = unwrap(
        await branch(forkPoint, () => makeBackend(), { id: TARGET_CLONE }),
      ).store;
      await target.nodes.NamedEmployee.create(
        { name: "Ada Lovelace", first: "Ada", last: "Lovelace" },
        { id: "emp" },
      );
      const source = unwrap(
        await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
      );
      await source.store.nodes.NamedPerson.update("m" as never, {
        last: "Lovelace",
        email: "moved@example.test",
      });
      await source.store.nodes.NamedPerson.create(
        { name: "N1", email: "m@example.test" },
        { id: "n1" },
      );
      await source.store.nodes.NamedPerson.create({ name: "N2" }, { id: "n2" });
      await source.store.identity.assertSame(
        { kind: "NamedPerson", id: "n1" },
        { kind: "NamedPerson", id: "n2" },
      );

      const artifact = unwrap(
        await planMergeIncremental<ModifiedGraph>({
          forkPoint,
          target,
          branches: [source],
          options: {
            branchOrder: [BRANCH_A],
            // A resolve entry is what runs the kind's sources; scoring itself
            // accepts nothing, so the base-unique `email` match is the only
            // non-identity edge.
            resolve: {
              NamedPerson: {
                ...ONE_BUCKET,
                threshold: 1,
                similarity: { kind: "custom", score: () => 0 },
              },
            },
            identity: { pairing: "definitional", onUniquenessConflict: "flag" },
          },
        }),
      );
      console.info(
        `[${entry.name}] modified-member review:`,
        artifact.review.identityConflicts,
        artifact.review.resolutions.map((resolution) => resolution.memberIds),
      );
      // `m`, `n1` and `n2` fused onto the committed `m` …
      expect(
        artifact.review.resolutions.find(
          (resolution) => resolution.canonicalId === "m",
        )?.memberIds,
      ).toEqual(["m", "n1", "n2"]);
      // … and the collision is m's own, so nothing is blamed on the pairing.
      expect(artifact.review.identityConflicts ?? []).toEqual([]);
      const applied = await applyMergePlan(target, artifact);
      if (isOk(applied)) throw new Error("expected a constraint refusal");
      expect(applied.error.code).toBe("GRAPH_MERGE_CONSTRAINT_CONFLICT");
    });
    // MUTATION CHECK: in `unfusedComponentWrites` drop the modification fold
    // (write `entity.props` alone) — `m`'s unfused write then lacks `last`,
    // the counterfactual finds no member-owned claim, the plan reports a
    // `uniqueness` conflict against the pairing and `toEqual([])` fails.

    /**
     * The counterfactual write lands under the RETYPED kind. `p` is staged as
     * both a `NamedPerson` and a `NamedEmployee`, `d` as both a `NamedPerson`
     * and a `NamedManager` (two ontology retype pairs), `c` is similarity-fused
     * with `p`, and `d` joins only through `same(c, d)`. The fused entity is
     * therefore a `NamedManager` whose `Ada Lovelace` key collides with the
     * committed manager. Without the pairing, `{p, p, c}` is a `NamedEmployee`
     * — a namespace where `Ada Lovelace` is free — so the pairing IS to blame,
     * the plan drops it and applies. A counterfactual written under the
     * un-retyped `NamedPerson` kind would instead meet the committed PERSON
     * `Ada Lovelace`, call the collision member-owned, drop nothing, and hand
     * back a plan the commit refuses.
     */
    it("retypes the counterfactual component write the way the plan does", async () => {
      const [base] = await createStoreWithSchema(
        retypeGraph,
        await makeBackend(),
        { history: true },
      );
      await base.nodes.NamedManager.create(
        { name: "Ada Lovelace", first: "Ada", last: "Lovelace" },
        { id: "mgr" },
      );
      await base.nodes.NamedPerson.create(
        { name: "Ada Lovelace", first: "Ada", last: "Lovelace" },
        { id: "per" },
      );
      const source = unwrap(
        await branch(base, () => makeBackend(), { id: BRANCH_A }),
      );
      await source.store.nodes.NamedPerson.create(
        { name: "C", first: "Ada" },
        { id: "c" },
      );
      await source.store.nodes.NamedPerson.create({ name: "D" }, { id: "d" });
      await source.store.nodes.NamedManager.create({ name: "D" }, { id: "d" });
      await source.store.nodes.NamedPerson.create(
        { name: "P", last: "Lovelace" },
        { id: "p" },
      );
      await source.store.nodes.NamedEmployee.create({ name: "P" }, { id: "p" });
      const pair = await source.store.identity.assertSame(
        { kind: "NamedPerson", id: "c" },
        { kind: "NamedPerson", id: "d" },
      );
      const result = await merge<RetypeGraph>(base, [source], {
        branchOrder: [BRANCH_A],
        reconcileTypes: "ontology",
        resolve: {
          NamedPerson: {
            ...ONE_BUCKET,
            threshold: 0.5,
            similarity: {
              kind: "custom",
              score: (left, right) =>
                (
                  [left.id as string, right.id as string]
                    .toSorted()
                    .join(",") === "c,p"
                ) ?
                  1
                : 0,
            },
          },
        },
        identity: { pairing: "definitional", onUniquenessConflict: "flag" },
      });
      if (isErr(result)) throw result.error;
      const conflicts = conflictsOfKind(result.data as never, "uniqueness");
      console.info(`[${entry.name}] retype conflicts:`, conflicts);
      expect(
        conflicts.map((conflict) => ({
          canonical: conflict.canonical,
          owner: conflict.owner.id,
          assertionIds: conflict.assertionIds,
        })),
      ).toEqual([
        {
          canonical: { kind: "NamedManager", id: "c" },
          owner: "mgr",
          assertionIds: [pair.assertion.id],
        },
      ]);
      // {p, p, c} landed as the NamedEmployee `c`; d stayed a manager of its own.
      expect(
        (await base.nodes.NamedEmployee.find())
          .map((row) => `${row.id}:${row.first ?? ""} ${row.last ?? ""}`)
          .toSorted(),
      ).toEqual(["c:Ada Lovelace"]);
      expect(
        (await base.nodes.NamedManager.find())
          .map((row) => row.id as string)
          .toSorted(),
      ).toEqual(["d", "mgr"]);
    });
    // MUTATION CHECK: in `unfusedComponentWrites` write `entity.kind` instead
    // of the retyped kind — the component probes as a `NamedPerson`, meets the
    // committed person `per`, the collision reads as member-owned, nothing is
    // dropped, and the merge is refused at the commit instead of applying.

    /**
     * The returned plan excludes exactly the pairings the report names. In one
     * pass, pairing X (`x1`,`x2`, also a scored match) and pairing Y (`y1`,`y2`,
     * identity only) both collapse an edge; the rebuild re-fuses X on its own
     * score, so only Y is carried — and the plan handed back must be rebuilt
     * from {Y} alone, so X's identity evidence is back on its resolution.
     */
    it("rebuilds the final plan from the attributed pairings when a pass cleared a suspect", async () => {
      const [base] = await createStoreWithSchema(
        edgeGraph,
        await makeBackend(),
        { history: true },
      );
      await base.nodes.Company.create({ name: "C" }, { id: "c" });
      const source = unwrap(
        await branch(base, () => makeBackend(), { id: BRANCH_A }),
      );
      for (const id of ["x1", "x2", "y1", "y2"]) {
        await source.store.nodes.Person.create({ name: "Ada" }, { id });
        await source.store.edges.worksAt.create(
          { kind: "Person", id },
          { kind: "Company", id: "c" },
          { role: "engineer" },
          { id: `edge-${id}` },
        );
      }
      await source.store.identity.assertSame(
        { kind: "Person", id: "x1" },
        { kind: "Person", id: "x2" },
      );
      const pairY = await source.store.identity.assertSame(
        { kind: "Person", id: "y1" },
        { kind: "Person", id: "y2" },
      );
      const result = await merge(base, [source], {
        branchOrder: [BRANCH_A],
        resolve: {
          Person: {
            ...ONE_BUCKET,
            threshold: 0.5,
            similarity: {
              kind: "custom",
              score: (left, right) =>
                (
                  [left.id as string, right.id as string]
                    .toSorted()
                    .join(",") === "x1,x2"
                ) ?
                  1
                : 0,
            },
          },
        },
        identity: { pairing: "definitional", onEdgeConflict: "flag" },
      });
      if (isErr(result)) throw result.error;
      const conflicts = conflictsOfKind(result.data as never, "edge");
      expect(conflicts.map((conflict) => conflict.assertionIds)).toEqual([
        [pairY.assertion.id],
      ]);
      // X fused (by score), Y did not.
      expect(
        (await base.nodes.Person.find())
          .map((row) => row.id as string)
          .toSorted(),
      ).toEqual(["x1", "y1", "y2"]);
      // The plan was rebuilt from {Y}: X's pairing is back in candidate
      // generation, so its resolution carries the identity source again.
      const resolution = result.data.resolutions.find(
        (entry) => entry.canonicalId === "x1",
      );
      expect(
        resolution?.decisiveEdges.some((edge) =>
          edge.sources.some((sourceRef) => sourceRef.kind === "identity"),
        ),
      ).toBe(true);
    });
    // MUTATION CHECK: return `current` instead of rebuilding from the
    // attributed set when the two differ — X's pairing stays excluded, its
    // resolution shows only the scored source, and the final `toBe(true)`
    // fails.

    /**
     * The dropped pairing is the one on the PATH between the collapsed
     * endpoints, not the cluster's whole pairing: `x`–`y`–`z`–`w` chained by
     * three assertions, with only `x` and `z` carrying edges that collapse.
     * `A1(x,y)` and `A2(y,z)` are on the `x`–`z` path and are dropped;
     * `A3(z,w)` hangs off it and still fuses `z` with `w`.
     */
    it("drops only the assertions on the path between the collapsed endpoints", async () => {
      const [base] = await createStoreWithSchema(
        edgeGraph,
        await makeBackend(),
        { history: true },
      );
      await base.nodes.Company.create({ name: "C" }, { id: "c" });
      const source = unwrap(
        await branch(base, () => makeBackend(), { id: BRANCH_A }),
      );
      for (const id of ["x1", "y1", "z1", "z2"]) {
        await source.store.nodes.Person.create({ name: "Ada" }, { id });
      }
      await source.store.edges.worksAt.create(
        { kind: "Person", id: "x1" },
        { kind: "Company", id: "c" },
        { role: "engineer" },
        { id: "edge-x" },
      );
      await source.store.edges.worksAt.create(
        { kind: "Person", id: "z1" },
        { kind: "Company", id: "c" },
        { role: "engineer" },
        { id: "edge-z" },
      );
      const assertionId = async (a: string, b: string): Promise<string> =>
        (
          await source.store.identity.assertSame(
            { kind: "Person", id: a },
            { kind: "Person", id: b },
          )
        ).assertion.id;
      const a1 = await assertionId("x1", "y1");
      const a2 = await assertionId("y1", "z1");
      await assertionId("z1", "z2");

      const result = await merge(base, [source], {
        branchOrder: [BRANCH_A],
        identity: { pairing: "definitional", onEdgeConflict: "flag" },
      });
      if (isErr(result)) throw result.error;
      const conflicts = conflictsOfKind(result.data as never, "edge");
      expect(conflicts).toHaveLength(1);
      expect(requireDefined(conflicts[0]).assertionIds).toEqual(
        [a1, a2].toSorted(),
      );
      // x, y and z land separately; A3 still folds z2 into z1.
      expect(
        (await base.nodes.Person.find())
          .map((row) => row.id as string)
          .toSorted(),
      ).toEqual(["x1", "y1", "z1"]);
      expect(
        (await base.edges.worksAt.find())
          .map((edge) => edge.id as string)
          .toSorted(),
      ).toEqual(["edge-x", "edge-z"]);
    });
    // MUTATION CHECK: have `droppedPairingFor` return every assertion of the
    // cluster (`cluster.branchesByAssertionId.keys()`) — `assertionIds` then
    // lists A3 too and `z2` survives as its own row, failing both assertions.
  },
);
