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
import { applyMergePlan, merge, planMerge } from "../../src/graph-merge/merge";
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

const BRANCH_A = asBranchId("branch-a");

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
          // The holder's OWN kind — the subclass row the scope reached.
          holder: { kind: "NamedEmployee", id: "emp" },
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
  },
);
