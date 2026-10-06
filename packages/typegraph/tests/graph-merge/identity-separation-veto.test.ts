/**
 * The always-on identity separation veto, and what an ordinary merge does with
 * a `same` assertion.
 *
 * A `different` assertion is an integrity fact, so the veto runs for EVERY
 * identity-enabled merge. What would otherwise abort inside the commit on the
 * separation relation's ordered-pair CHECK is decided at plan time, naming
 * both entities and the assertion that separated them:
 *
 *   - a SCORED match between separated entities is dropped and reported as a
 *     typed `separation` conflict; the merge continues;
 *   - a DEFINITIONAL match that survives the base and diameter guards fails
 *     the plan;
 *   - a TRANSITIVE fusion through a third node, where no single candidate edge
 *     is separated, fails the plan.
 *
 * A `same` assertion is ledger truth the merge carries across; it never fuses
 * the rows it names.
 *
 * Runs on every backend in the merge matrix (SQLite + in-process PGlite, plus
 * server Postgres when `POSTGRES_URL` is set) — the veto decision is shared
 * code, the separation probe is not, so both must agree.
 */
import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  subClassOf,
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

const uniqueEmailGraph = defineGraph({
  id: "identity_separation_veto",
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
type UniqueEmailGraph = typeof uniqueEmailGraph;

/**
 * The same kinds with NO unique constraint, so the new-vs-base sources pull no
 * base members into scope. That keeps the component-level base guard (which
 * refuses to collapse two COMMITTED entities on its own) out of the way, so the
 * transitive case below exercises the post-cluster separation assertion rather
 * than a base-ambiguity split.
 */
const similarityGraph = defineGraph({
  id: "identity_separation_veto_similarity",
  nodes: { Person: { type: Person }, Robot: { type: Robot } },
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});
type SimilarityGraph = typeof similarityGraph;

const Employee = defineNode("Employee", {
  schema: z.object({ name: z.string(), email: z.string() }),
});

/**
 * `Employee` refines `Person`, so under `reconcileTypes: "ontology"` a
 * `Person` and an `Employee` staged under one id are one entity at a refined
 * type: a definitional match no similarity score is consulted for.
 */
const retypeGraph = defineGraph({
  id: "identity_separation_veto_retype",
  nodes: { Person: { type: Person }, Employee: { type: Employee } },
  edges: {},
  ontology: [subClassOf(Employee, Person)],
  identity: { sameIdAcrossKinds: "ignore" },
});

/**
 * A resolve config whose SCORING never accepts anything: the forced
 * (definitional) edges a unique constraint produces still pass through, so a
 * test can drive the forced path alone.
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

describe.each(backendMatrix())("identity separation veto [$name]", (entry) => {
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

  async function makeStore(): Promise<Store<UniqueEmailGraph>> {
    const [store] = await createStoreWithSchema(
      uniqueEmailGraph,
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
    store: Store<UniqueEmailGraph> | Store<SimilarityGraph>,
  ): Promise<readonly string[]> {
    const rows = await store.nodes.Person.find();
    return rows.map((row) => row.id as string).toSorted();
  }

  /**
   * A DEFINITIONAL match that SURVIVES the base and diameter guards is
   * refused at PLAN time.
   *
   * The target already holds `Person:x` and `Employee:x` apart. The branch
   * recreates both, and ontology reconciliation treats a `Person` and its
   * subclass `Employee` staged under one id as a single entity — a forced
   * edge between two staged nodes. No base member is involved, so no guard
   * severs it and the cluster really would collapse two separated classes.
   */
  it("refuses a definitional match that survives the guards", async () => {
    const [forkPoint] = await createStoreWithSchema(
      retypeGraph,
      await makeBackend(),
      { history: true },
    );
    const target = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: TARGET_CLONE }),
    ).store;
    const person = { kind: "Person", id: "x" } as const;
    const employee = { kind: "Employee", id: "x" } as const;
    const props = { name: "X", email: "x@example.test" };
    await target.nodes.Person.create(props, { id: "x" });
    await target.nodes.Employee.create(props, { id: "x" });
    await target.identity.assertDifferent(person, employee);

    const source = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await source.store.nodes.Person.create(props, { id: "x" });
    await source.store.nodes.Employee.create(props, { id: "x" });

    const result = await mergeIncremental({
      forkPoint,
      target,
      branches: [source],
      options: { branchOrder: [BRANCH_A], reconcileTypes: "ontology" },
    });

    if (isOk(result)) throw new Error("expected a separation refusal");
    console.info("separation refusal", result.error.details);
    expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
    // The load-bearing half: the code AND the phase. Without the veto the
    // merge reaches the commit and dies on the separation relation's CHECK
    // under a different code.
    expect(result.error.code).toBe("GRAPH_MERGE_IDENTITY_SEPARATION_CONFLICT");
    expect(
      [result.error.details["a"], result.error.details["b"]].toSorted(
        (left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
    ).toEqual([employee, person]);
    // The refusal names the assertion that separated them, not just that
    // something did.
    expect(result.error.details["assertionIds"]).toHaveLength(1);
    // The EDGE-level diagnosis, not the cluster-level one: a surviving
    // definitional claim is refused naming the source that proposed it.
    expect(result.error.details["sources"]).toEqual([
      expect.objectContaining({ kind: "retype" }),
    ]);
    expect(result.error.details["cluster"]).toBeUndefined();
    // A plan-time refusal writes nothing: the separation still stands.
    expect(await target.identity.areDifferent(person, employee)).toBe(true);
  });

  /**
   * The counterpart, and the reason the definitional refusal runs AFTER the
   * guards: a forced BASE match between two committed entities is severed
   * by the component base guard, so it never fuses anything. Refusing it up
   * front would fail a merge that is harmless — this fixture merges cleanly
   * and leaves both entities, and their separation, intact.
   */
  it("does not refuse a forced base match the base guard already severed", async () => {
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
    // Shares `alpha`'s unique email, so a base source forces the match.
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
   * A TRANSITIVE fusion is refused too.
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
                const ids = [left.id as string, right.id as string].toSorted();
                return ids.includes("gamma") ? 1 : 0;
              },
            },
          },
        },
      },
    });

    if (isOk(result)) throw new Error("expected a separation refusal");
    expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
    expect(result.error.code).toBe("GRAPH_MERGE_IDENTITY_SEPARATION_CONFLICT");
    // The refusal names the separated PAIR, not the bridge that fused them.
    expect(result.error.details["cluster"]).toHaveLength(3);
    expect(await livePersonIds(target)).toEqual(before);
  });

  /**
   * A `same` assertion is carried across as ledger truth and never fuses the
   * rows it names — whether both endpoints are staged, one is already
   * committed on the target, or the two are different kinds.
   */
  it("lands a same assertion without fusing the nodes it spans", async () => {
    const store = await makeStore();
    await store.nodes.Person.create(
      { name: "Ada", email: "committed@example.test" },
      { id: "committed" },
    );
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
    await source.store.nodes.Robot.create(
      { name: "Ada", email: "r1@example.test" },
      { id: "r1" },
    );
    await source.store.identity.assertSame(
      { kind: "Person", id: "a1" },
      { kind: "Person", id: "b1" },
    );
    await source.store.identity.assertSame(
      { kind: "Person", id: "committed" },
      { kind: "Person", id: "a1" },
    );
    await source.store.identity.assertSame(
      { kind: "Person", id: "b1" },
      { kind: "Robot", id: "r1" },
    );

    const result = await merge(store, [source], { branchOrder: [BRANCH_A] });
    if (isErr(result)) throw result.error;
    console.info("merge report", {
      merged: result.data.merged,
      dropped: result.data.dropped,
      identityConflicts: result.data.identityConflicts,
    });

    expect(await livePersonIds(store)).toEqual(["a1", "b1", "committed"]);
    expect(result.data.resolutions).toEqual([]);
    // Every staged assertion is a write: none dropped, none reported.
    expect(result.data.merged.identity.asserted).toBe(3);
    expect(
      result.data.dropped.filter((item) => item.kind === "identity"),
    ).toEqual([]);
    expect(result.data.identityConflicts).toEqual([]);
    expect(
      await store.identity.areSame(
        { kind: "Person", id: "committed" },
        { kind: "Robot", id: "r1" },
      ),
    ).toBe(true);
  });

  /**
   * A SCORED
   * match is recall, so the ledger's veto drops the proposal, reports it,
   * and the merge continues — the plan is still applicable.
   */
  it("drops and reports a scored match the ledger holds apart", async () => {
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
        candidateDiagnostics: { limit: 50 },
        resolve: {
          Person: {
            ...ONE_BUCKET,
            threshold: 0.5,
            similarity: {
              kind: "custom",
              // Only the separated pair scores: nothing else may fuse, so
              // the drop is observable on its own.
              score: (left, right) => {
                const ids = [left.id as string, right.id as string].toSorted();
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
    // The diagnostic surface must say what actually happened to the
    // vetoed pair — "excluded" for "separation" — never "retained", which
    // would flatly contradict the `identityConflicts` entry above for the
    // identical pair.
    const alphaBetaDiagnostic = result.data.candidateDiagnostics?.entries.find(
      (diagnostic) =>
        diagnostic.evidence.decision === "scored" &&
        [diagnostic.evidence.a.id, diagnostic.evidence.b.id]
          .toSorted()
          .join(",") === "alpha,beta",
    );
    expect(alphaBetaDiagnostic).toBeDefined();
    expect(alphaBetaDiagnostic?.scoreDecision).toBe("accepted");
    expect(alphaBetaDiagnostic?.clusterDisposition).toEqual({
      kind: "excluded",
      reason: "separation",
    });
  });

  /**
   * The veto reads the ledger as it stands at plan time, not a fact an
   * earlier identity call on the same Store handle settled. `assertSame` on a
   * graph holding no `different` assertion proves the separation relation's
   * readiness for the handle; the `assertDifferent` that follows makes "this
   * graph separates nothing" false, and the merge after it must still drop
   * and report the scored pair.
   *
   * Without the ledger read the capture is skipped, the scored match is
   * accepted, and the merge dies at commit with `GRAPH_MERGE_IDENTITY_CONFLICT`.
   */
  it("honors a different assertion made after an earlier assertSame on the same handle", async () => {
    const forkPoint = await makeSimilarityStore();
    const target = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: TARGET_CLONE }),
    ).store;
    for (const id of ["alpha", "beta", "p", "q"]) {
      await target.nodes.Person.create(
        { name: id, email: `${id}@example.test` },
        { id },
      );
    }
    await target.identity.assertSame(
      { kind: "Person", id: "p" },
      { kind: "Person", id: "q" },
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
              score: (left, right) => {
                const ids = [left.id as string, right.id as string].toSorted();
                return ids[0] === "alpha" && ids[1] === "beta" ? 1 : 0;
              },
            },
          },
        },
      },
    });

    if (isErr(result)) {
      console.info("separation veto skipped", {
        code: result.error.code,
        message: result.error.message,
      });
      throw result.error;
    }
    expect(result.data.identityConflicts).toHaveLength(1);
    expect(result.data.identityConflicts[0]).toMatchObject({
      kind: "separation",
      a: { kind: "Person", id: "alpha" },
      b: { kind: "Person", id: "beta" },
    });
    expect(await livePersonIds(target)).toEqual([
      "alpha",
      "beta",
      "delta",
      "p",
      "q",
    ]);
    expect(
      await target.identity.areDifferent(
        { kind: "Person", id: "alpha" },
        { kind: "Person", id: "beta" },
      ),
    ).toBe(true);
  });
});
