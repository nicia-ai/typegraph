/**
 * The post-write affected-class assertion: after a merge commit's identity
 * DML, the applier re-derives the identity classes the merge touched FROM THE
 * WRITTEN STATE, inside the same transaction, and refuses a contradiction
 * there.
 *
 * What every case below has in common is a materialized identity closure that
 * lags the ledger it summarizes. That matters because the closure is what the
 * applier's own per-assertion validation resolves classes through, so while it
 * lags, a legal identity write can be talked into a contradiction and the
 * writes that follow are validated against a class shape that no longer
 * exists. The plan-time simulation cannot see it either: it reasons about the
 * ledger, and the ledger alone does not say which class a same-id fold puts a
 * node in. Only re-deriving the affected classes after the writes — and
 * rebuilding the closure when they do not agree with the ledger — catches it.
 */
import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  disjointWith,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import { IdentityMergeConflictError } from "../../src/graph-merge/errors";
import type { MergePlan } from "../../src/graph-merge/merge";
import { commitPlan, mergeIncremental } from "../../src/graph-merge/merge";
import { affectedIdentityClassSeeds } from "../../src/graph-merge/merge-identity";
import { mergeKey } from "../../src/graph-merge/node-key";
import { isErr, isOk, unwrap } from "../../src/graph-merge/result";
import { asBranchId } from "../../src/graph-merge/types";
import { importGraph } from "../../src/interchange";
import { sql } from "../../src/query/sql-fragment";
import { asCompiledStatementSql } from "../../src/query/sql-intent";
import { storeRuntime } from "../../src/store/runtime-port";
import {
  backendMatrix,
  getStoreBackend,
  identityAssertionDocument,
} from "./test-utils";

const Anchor = defineNode("Anchor", {
  schema: z.object({ name: z.string() }),
});
const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Robot = defineNode("Robot", {
  schema: z.object({ name: z.string() }),
});

/**
 * Same-id folding on, with a disjoint pair a fold can pull into one class —
 * the contradiction the ledger alone never states.
 */
const foldGraph = defineGraph({
  id: "identity_commit_closure_fold",
  nodes: {
    Anchor: { type: Anchor },
    Person: { type: Person },
    Robot: { type: Robot },
  },
  edges: {},
  ontology: [disjointWith(Person, Robot)],
  identity: { sameIdAcrossKinds: "fold" },
});
type FoldGraph = typeof foldGraph;

/** Assertion-only identity, for the closure-repair case. */
const ledgerGraph = defineGraph({
  id: "identity_commit_closure_ledger",
  nodes: { Anchor: { type: Anchor } },
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});

const BRANCH_A = asBranchId("branch-a");
const TARGET_CLONE = asBranchId("target-clone");

/** An empty plan; the commit tests override only the identity slice. */
function emptyFoldPlan(): MergePlan<FoldGraph> {
  return {
    canonicalEntities: [],
    survivingModifications: [],
    nodeDeletions: new Map(),
    edgeDeletions: new Map(),
    mergedEdges: [],
    inheritedEdgeBaseProps: new Map(),
    retypeMap: new Map(),
    resolutions: [],
    propertyConflicts: [],
    deleteModifyConflicts: [],
    typeReconciliations: [],
    dropped: [],
    baseAmbiguities: [],
    provenanceRecords: [],
    warnings: [],
    identityAssertions: [],
    identityRetractions: [],
    canonicalOf: new Map(),
  };
}

/**
 * Empties the materialized identity closure behind the store's back — the
 * state a lagging or never-run incremental repair leaves behind, and the one
 * `rebuildIdentityClosure()` exists to get a store out of.
 */
async function dropMaterializedClosure(backend: GraphBackend): Promise<void> {
  const executeStatement = backend.executeStatement;
  if (executeStatement === undefined) {
    throw new Error("matrix backend must support statement execution");
  }
  await executeStatement(
    asCompiledStatementSql(sql`DELETE FROM typegraph_identity_closure`),
  );
}

describe.each(backendMatrix())(
  "identity commit-transaction closure assertion [$name]",
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

    /**
     * The fixture both contradiction tests commit onto.
     *
     * `Anchor:k` and `Robot:k` are one class by same-id folding, and
     * `same(z, k)` joins `Anchor:z` to it — all legal, all materialized. The
     * closure is then dropped, and `assertSame(p, z)` is accepted precisely
     * BECAUSE of the lag: it reads `Anchor:z` and `Person:p` as singletons
     * instead of seeing that z's real class already contains a `Robot`, which
     * the ontology declares disjoint with `Person`.
     *
     * Nothing in the ledger states that contradiction — it takes the fold at
     * id `k` to see it — so no ledger-level guard, at plan time or in the
     * commit window, can refuse what follows.
     */
    async function corruptedFoldTarget(): Promise<
      Readonly<{ forkPoint: Store<FoldGraph>; target: Store<FoldGraph> }>
    > {
      const [forkPoint] = await createStoreWithSchema(
        foldGraph,
        await makeBackend(),
      );
      for (const id of ["z", "k", "w"]) {
        await forkPoint.nodes.Anchor.create({ name: id }, { id });
      }
      await forkPoint.nodes.Robot.create({ name: "k" }, { id: "k" });
      await forkPoint.nodes.Person.create({ name: "p" }, { id: "p" });
      await forkPoint.identity.assertSame(
        { kind: "Anchor", id: "z" },
        { kind: "Anchor", id: "k" },
      );
      // Cloned BEFORE the corruption: a working copy is a faithful
      // re-import, which would refuse the contradictory assertion.
      const target = unwrap(
        await branch(forkPoint, () => makeBackend(), { id: TARGET_CLONE }),
      ).store;
      await dropMaterializedClosure(getStoreBackend(target));
      await target.identity.assertSame(
        { kind: "Person", id: "p" },
        { kind: "Anchor", id: "z" },
      );
      return { forkPoint, target };
    }

    /** The class the commit must refuse to extend, and what it holds. */
    async function expectUnextendedClass(
      target: Store<FoldGraph>,
    ): Promise<void> {
      const rows = await storeRuntime(target).identityAssertionRowsByIds([
        "same-wz",
      ]);
      expect(rows.get("same-wz")).toBeUndefined();
      expect(
        await target.identity.areSame(
          { kind: "Anchor", id: "w" },
          { kind: "Anchor", id: "z" },
        ),
      ).toBe(false);
    }

    it("refuses the contradiction the lagging closure hid (snapshot commit)", async () => {
      // `commitPlan` is the snapshot commit path with no plan-time simulation
      // in front of it at all — the plan arrives resolved. Only the guards
      // inside its transaction stand between it and the ledger.
      const { target } = await corruptedFoldTarget();
      const plan: MergePlan<FoldGraph> = {
        ...emptyFoldPlan(),
        identityAssertions: [
          {
            id: "same-wz",
            relation: "same",
            a: { kind: "Anchor", id: "w" },
            b: { kind: "Anchor", id: "z" },
            validFrom: "2024-01-01T00:00:00.000Z",
          },
        ],
      };

      await expect(commitPlan(target, plan)).rejects.toThrow(
        IdentityMergeConflictError,
      );
      await expectUnextendedClass(target);
    });

    it("refuses the contradiction the lagging closure hid (incremental commit)", async () => {
      const { forkPoint, target } = await corruptedFoldTarget();
      const assertBranch = unwrap(
        await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
      );
      const branchImport = await importGraph(
        assertBranch.store,
        identityAssertionDocument("Anchor", "same-wz", "w", "z"),
        { onConflict: "skip" },
      );
      expect(branchImport.success).toBe(true);

      const result = await mergeIncremental({
        forkPoint,
        target,
        branches: [assertBranch],
        options: { branchOrder: [BRANCH_A] },
      });
      expect(isErr(result)).toBe(true);
      if (isOk(result)) throw new Error("Expected identity merge conflict");
      expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
      expect(result.error.code).toBe("GRAPH_MERGE_IDENTITY_CONFLICT");
      expect(result.error.details["identityCode"]).toBe(
        "IDENTITY_CONTRADICTION",
      );
      await expectUnextendedClass(target);
    });

    it("repairs a lagging closure inside the commit and lets the merge stand", async () => {
      // The same lag with no contradiction underneath it. The merge must
      // succeed — and must not leave the closure it validated against still
      // broken, because the rebuild runs in the merge's own transaction.
      const [forkPoint] = await createStoreWithSchema(
        ledgerGraph,
        await makeBackend(),
      );
      for (const id of ["a", "b", "c"]) {
        await forkPoint.nodes.Anchor.create({ name: id }, { id });
      }
      await forkPoint.identity.assertSame(
        { kind: "Anchor", id: "a" },
        { kind: "Anchor", id: "b" },
      );
      const target = unwrap(
        await branch(forkPoint, () => makeBackend(), { id: TARGET_CLONE }),
      ).store;
      const assertBranch = unwrap(
        await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
      );
      const branchImport = await importGraph(
        assertBranch.store,
        identityAssertionDocument("Anchor", "same-bc", "b", "c"),
        { onConflict: "skip" },
      );
      expect(branchImport.success).toBe(true);
      await dropMaterializedClosure(getStoreBackend(target));

      const result = await mergeIncremental({
        forkPoint,
        target,
        branches: [assertBranch],
        options: { branchOrder: [BRANCH_A] },
      });
      if (isErr(result)) throw result.error;
      expect(isOk(result)).toBe(true);

      // The merge's own pair AND the pre-existing one the drop hid: both read
      // as one class again, and the store's own validation agrees.
      expect(
        await target.identity.areSame(
          { kind: "Anchor", id: "b" },
          { kind: "Anchor", id: "c" },
        ),
      ).toBe(true);
      expect(
        await target.identity.areSame(
          { kind: "Anchor", id: "a" },
          { kind: "Anchor", id: "b" },
        ),
      ).toBe(true);
      await expect(
        storeRuntime(target).validateIdentity(),
      ).resolves.toBeUndefined();
    });
  },
);

describe("affectedIdentityClassSeeds", () => {
  const emptyPlan = {
    canonicalEntities: [],
    identityAssertions: [],
    identityRetractions: [],
    nodeDeletions: new Map<string, string>(),
    retypeMap: new Map<string, string>(),
    canonicalOf: new Map<string, string>(),
  } as unknown as Parameters<typeof affectedIdentityClassSeeds>[0];

  type PlanAssertion = (typeof emptyPlan)["identityAssertions"][number];

  function assertion(
    id: string,
    a: Readonly<{ kind: string; id: string }>,
    b: Readonly<{ kind: string; id: string }>,
  ): PlanAssertion {
    return {
      id,
      relation: "same",
      a,
      b,
      validFrom: "2024-01-01T00:00:00.000Z",
    } as unknown as PlanAssertion;
  }

  it("seeds both endpoints of assertions and retractions", () => {
    const plan = {
      ...emptyPlan,
      identityAssertions: [
        assertion(
          "x",
          { kind: "Anchor", id: "a" },
          { kind: "Anchor", id: "b" },
        ),
      ],
      identityRetractions: [
        assertion(
          "y",
          { kind: "Anchor", id: "c" },
          { kind: "Person", id: "d" },
        ),
      ],
    };
    expect(affectedIdentityClassSeeds(plan, "ignore")).toEqual([
      { kind: "Anchor", id: "a" },
      { kind: "Anchor", id: "b" },
      { kind: "Anchor", id: "c" },
      { kind: "Person", id: "d" },
    ]);
  });

  it("adds written node identities only under the fold profile", () => {
    // The commit writes a reconciled survivor under its RETYPED kind, so that
    // is the identity whose class a fold can move.
    const plan = {
      ...emptyPlan,
      canonicalEntities: [{ kind: "Staff", canonicalId: "s", props: {} }],
      retypeMap: new Map([[mergeKey("Staff", "s"), "Employee"]]),
    } as unknown as typeof emptyPlan;
    expect(affectedIdentityClassSeeds(plan, "fold")).toEqual([
      { kind: "Employee", id: "s" },
    ]);
    expect(affectedIdentityClassSeeds(plan, "ignore")).toEqual([]);
  });

  it("never seeds an identity the plan deletes", () => {
    const plan = {
      ...emptyPlan,
      identityAssertions: [
        assertion(
          "x",
          { kind: "Anchor", id: "a" },
          { kind: "Anchor", id: "gone" },
        ),
      ],
      canonicalEntities: [{ kind: "Anchor", canonicalId: "gone", props: {} }],
      nodeDeletions: new Map([[mergeKey("Anchor", "gone"), "Anchor"]]),
    } as unknown as typeof emptyPlan;
    expect(affectedIdentityClassSeeds(plan, "fold")).toEqual([
      { kind: "Anchor", id: "a" },
    ]);
  });
});
