import type { GraphBackend } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  disjointWith,
  subClassOf,
} from "@nicia-ai/typegraph";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  IdentityContradictionError,
  NodeNotFoundError,
  ValidationError,
} from "../../src/errors";
import { branch } from "../../src/graph-merge/branch";
import {
  BaseVersionMismatchError,
  IdentityMergeConflictError,
  MERGE_ERROR_CODES,
} from "../../src/graph-merge/errors";
import {
  applyMergePlan,
  merge,
  mergeIncremental,
  planMerge,
} from "../../src/graph-merge/merge";
import {
  assertNoContradictoryIdentityClosure,
  DUPLICATE_IDENTITY_ASSERTION_DROP_REASON,
  EMPTY_REMAPPED_IDENTITY_WINDOW_DROP_REASON,
  planIdentityChanges,
  REDUNDANT_IDENTITY_ASSERTION_DROP_REASON,
  remapIdentityAssertionEndpoints,
  translateIdentityCommitError,
} from "../../src/graph-merge/merge-identity";
import { type MergeKey, mergeKey } from "../../src/graph-merge/node-key";
import { isErr, isOk, unwrap } from "../../src/graph-merge/result";
import type { StagingSet } from "../../src/graph-merge/staging";
import { stageBranches } from "../../src/graph-merge/staging";
import { enumerateAllNodes } from "../../src/graph-merge/state-diff";
import type { IdentityTransferAssertion } from "../../src/graph-merge/typegraph-internal";
import type { BranchId } from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { storeRuntime } from "../../src/store/runtime-port";
import { requireDefined } from "../../src/utils/presence";
import { createPgliteFixturePool } from "./pglite-fixture-pool";
import { backendMatrix, getStoreBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "identity-merge",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

/** A Patient graph whose `name` drives similarity resolution — for the endpoint-remap case. */
const Patient = defineNode("Patient", {
  schema: z.object({ name: z.string(), birthDate: z.string() }),
});

const patientGraph = defineGraph({
  id: "identity-merge-patient",
  nodes: { Patient: { type: Patient } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

/**
 * A subclass graph for the ontology-retype case. `sameIdAcrossKinds: "ignore"`
 * keeps assertion endpoints strictly `(kind, id)`, so an assertion naming the
 * PRE-retype kind can only bind if the merge remapped it through the retype
 * cascade — folding would mask the bug by matching on the bare id.
 */
const Staff = defineNode("Staff", {
  schema: z.object({ name: z.string(), birthDate: z.string() }),
});

const Employee = defineNode("Employee", {
  schema: z.object({ name: z.string(), birthDate: z.string() }),
});

const employeeGraph = defineGraph({
  id: "identity-merge-employee",
  nodes: { Staff: { type: Staff }, Employee: { type: Employee } },
  edges: {},
  ontology: [subClassOf(Employee, Staff)],
  identity: { sameIdAcrossKinds: "ignore" },
});

const BRANCH_A = asBranchId("branch-a");
const BRANCH_B = asBranchId("branch-b");
const IDENTITY_CONFLICT_CODE = MERGE_ERROR_CODES.identityConflict;
function narrowedAssertionWarning(assertionId: string): string {
  return `Identity assertion ${JSON.stringify(assertionId)} was narrowed from [2020-01-01T00:00:00.000Z, open) to [2022-01-01T00:00:00.000Z, open) to fit its remapped endpoint windows.`;
}

const pglitePool = createPgliteFixturePool();
afterAll(async () => {
  await pglitePool.dispose();
});

describe.each(backendMatrix())("identity merge [$name]", (entry) => {
  let cleanups: (() => Promise<void>)[];

  beforeEach(() => {
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
  });

  async function makeBackend(): Promise<GraphBackend> {
    const fixture =
      entry.name === "PGlite" ?
        await pglitePool.makeFixture()
      : await entry.make();
    cleanups.push(fixture.cleanup);
    return fixture.backend;
  }

  async function createBase(withAssertion = false) {
    const [store] = await createStoreWithSchema(graph, await makeBackend());
    const first = await store.nodes.Person.create(
      { name: "First" },
      { id: "first" },
    );
    const second = await store.nodes.Person.create(
      { name: "Second" },
      { id: "second" },
    );
    const assertion =
      withAssertion ?
        (await store.identity.assertSame(first, second)).assertion
      : undefined;
    return { store, first, second, assertion };
  }

  async function createPatientRemapScenario() {
    const backend = await makeBackend();
    const [baseStore] = await createStoreWithSchema(patientGraph, backend, {
      revisionTracking: true,
    });
    const anchor = await baseStore.nodes.Patient.create(
      { name: "Anchor Person", birthDate: "1990-01-01" },
      { id: "anchor", validFrom: "2019-01-01T00:00:00.000Z" },
    );
    const branchA = unwrap(
      await branch(baseStore, () => makeBackend(), { id: BRANCH_A }),
    );
    const branchB = unwrap(
      await branch(baseStore, () => makeBackend(), { id: BRANCH_B }),
    );
    const anna = await branchA.store.nodes.Patient.create(
      { name: "Anna Rivera", birthDate: "1974-03-09" },
      {
        id: "p-anna",
        validFrom: "2020-01-01T00:00:00.000Z",
      },
    );
    const { assertion } = await branchA.store.identity.assertSame(
      anna,
      anchor,
      {
        validFrom: "2020-01-01T00:00:00.000Z",
      },
    );
    await branchB.store.nodes.Patient.create(
      { name: "Ana Rivera", birthDate: "1974-03-09" },
      {
        id: "p-ana",
        validFrom: "2022-01-01T00:00:00.000Z",
      },
    );
    return { backend, baseStore, anchor, branchA, branchB, assertion };
  }

  const patientRemapOptions = {
    resolve: {
      Patient: {
        block: (node: unknown) => (node as { birthDate?: string }).birthDate,
        similarity: { kind: "fulltext", fields: ["name"] },
        threshold: 0.85,
      },
    },
    branchOrder: [BRANCH_A, BRANCH_B],
  } as const;

  it("plans and applies adjacent historical identity relations", async () => {
    const [store] = await createStoreWithSchema(graph, await makeBackend());
    const first = await store.nodes.Person.create(
      { name: "Historical first" },
      { id: "historical-first", validFrom: "2019-01-01T00:00:00.000Z" },
    );
    const second = await store.nodes.Person.create(
      { name: "Historical second" },
      { id: "historical-second", validFrom: "2019-01-01T00:00:00.000Z" },
    );
    const sameBranch = unwrap(
      await branch(store, () => makeBackend(), { id: BRANCH_A }),
    );
    const differentBranch = unwrap(
      await branch(store, () => makeBackend(), { id: BRANCH_B }),
    );
    await sameBranch.store.identity.assertSame(first, second, {
      validFrom: "2020-01-01T00:00:00.000Z",
      validTo: "2022-01-01T00:00:00.000Z",
    });
    await differentBranch.store.identity.assertDifferent(first, second, {
      validFrom: "2022-01-01T00:00:00.000Z",
      validTo: "2023-01-01T00:00:00.000Z",
    });

    const result = await merge(store, [sameBranch, differentBranch], {
      branchOrder: [BRANCH_A, BRANCH_B],
    });
    if (isErr(result)) throw result.error;

    expect(
      await store
        .asOf("2021-01-01T00:00:00.000Z")
        .identity.areSame(first, second),
    ).toBe(true);
    expect(
      await store
        .asOf("2022-06-01T00:00:00.000Z")
        .identity.areDifferent(first, second),
    ).toBe(true);
    expect(await store.identity.areSame(first, second)).toBe(false);
    expect(await store.identity.areDifferent(first, second)).toBe(false);
  });

  /**
   * A four-node base already holding `same(second, third)` — the inherited link
   * the closure checks must fold in, since no branch restates it.
   */
  async function createChainBase() {
    const [store] = await createStoreWithSchema(graph, await makeBackend());
    const [first, second, third, fourth] = await Promise.all(
      ["first", "second", "third", "fourth"].map((id) =>
        store.nodes.Person.create({ name: id }, { id }),
      ),
    );
    const { assertion } = await store.identity.assertSame(
      requireDefined(second),
      requireDefined(third),
    );
    return {
      store,
      first: requireDefined(first),
      second: requireDefined(second),
      third: requireDefined(third),
      fourth: requireDefined(fourth),
      assertion,
    };
  }

  it("preserves assertion id and validFrom in an empty working-copy clone", async () => {
    const { store, assertion, first } = await createBase(true);
    const fork = unwrap(await branch(store, () => makeBackend()));

    expect(await fork.store.identity.assertionsOf(first)).toEqual([assertion]);
  });

  it("chooses the same deterministic survivor for every branch permutation", async () => {
    const { store, first, second } = await createBase();
    const branchA = unwrap(await branch(store, () => makeBackend()));
    const branchB = unwrap(await branch(store, () => makeBackend()));
    const { assertion: firstAssertion } =
      await branchA.store.identity.assertSame(first, second);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await branchB.store.identity.assertSame(first, second);

    const forward = planIdentityChanges(
      await stageBranches(store, [branchA, branchB]),
      new Map(),
    );
    const reverse = planIdentityChanges(
      await stageBranches(store, [branchB, branchA]),
      new Map(),
    );
    expect(reverse).toEqual(forward);
    expect(forward.assertions).toEqual([
      expect.objectContaining({ id: firstAssertion.id }),
    ]);

    expect(isOk(await merge(store, [branchA, branchB], {}))).toBe(true);
    expect(await store.identity.assertionsOf(first)).toEqual([firstAssertion]);
  });

  it("rejects opposing assertions as a typed merge conflict", async () => {
    const { store, first, second } = await createBase();
    const sameBranch = unwrap(await branch(store, () => makeBackend()));
    const differentBranch = unwrap(await branch(store, () => makeBackend()));
    await sameBranch.store.identity.assertSame(first, second);
    await differentBranch.store.identity.assertDifferent(first, second);

    const result = await merge(store, [sameBranch, differentBranch], {});
    expect(isErr(result)).toBe(true);
    if (isOk(result)) throw new Error("Expected identity merge conflict");
    expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
  });

  it("merges convergent retract + reassert of one pair", async () => {
    const { store, first, second, assertion } = await createBase(true);
    if (assertion === undefined) throw new Error("Missing base assertion");
    const retractBranch = unwrap(await branch(store, () => makeBackend()));
    const reassertBranch = unwrap(await branch(store, () => makeBackend()));
    // Both branches AGREE the inherited assertion dies; one went further and
    // re-asserted the pair under a new id. That is convergence, not a race, so
    // both effects apply: the old id is retracted and the new one is asserted.
    await retractBranch.store.identity.retractAssertion(assertion.id);
    await reassertBranch.store.identity.retractAssertion(assertion.id);
    const reasserted = await reassertBranch.store.identity.assertSame(
      first,
      second,
    );

    const result = await merge(store, [retractBranch, reassertBranch], {});
    if (isErr(result)) throw result.error;
    expect(result.data.merged.identity).toEqual({ asserted: 1, retracted: 1 });

    const current = await store.identity.assertionsOf(first);
    expect(current.map((entry) => entry.id)).toEqual([reasserted.assertion.id]);
    expect(await store.identity.areSame(first, second)).toBe(true);
  });

  it("applies the exact reviewed windows for multiple and unrelated retractions", async () => {
    const [store] = await createStoreWithSchema(graph, await makeBackend(), {
      history: true,
      revisionTracking: true,
    });
    const nodes = await store.nodes.Person.bulkCreate(
      [
        "same-a",
        "same-b",
        "different-a",
        "different-b",
        "only-a",
        "only-b",
      ].map((id) => ({
        id: `plan-window-${id}`,
        props: { name: id },
        validFrom: "2019-01-01T00:00:00.000Z",
      })),
    );
    const sameA = requireDefined(nodes[0]);
    const sameB = requireDefined(nodes[1]);
    const differentA = requireDefined(nodes[2]);
    const differentB = requireDefined(nodes[3]);
    const onlyA = requireDefined(nodes[4]);
    const onlyB = requireDefined(nodes[5]);
    const baseSame = await store.identity.assertSame(sameA, sameB);
    const baseDifferent = await store.identity.assertDifferent(
      differentA,
      differentB,
    );
    const baseOnly = await store.identity.assertSame(onlyA, onlyB);
    const source = unwrap(
      await branch(store, () => makeBackend(), { id: BRANCH_A }),
    );
    const retractedSame = requireDefined(
      await source.store.identity.retractAssertion(baseSame.assertion.id),
    );
    const replacementDifferent = await source.store.identity.assertDifferent(
      sameA,
      sameB,
    );
    const retractedDifferent = requireDefined(
      await source.store.identity.retractAssertion(baseDifferent.assertion.id),
    );
    const replacementSame = await source.store.identity.assertSame(
      differentA,
      differentB,
    );
    const retractedOnly = requireDefined(
      await source.store.identity.retractAssertion(baseOnly.assertion.id),
    );

    const artifact = unwrap(await planMerge(store, [source]));
    const applied = unwrap(await applyMergePlan(store, artifact));
    expect(applied.merged.identity).toEqual({ asserted: 2, retracted: 3 });

    const archival = await storeRuntime(store).identityAssertionsAtTarget(
      storeRuntime(store).backend,
      "archival",
    );
    const committedById = new Map(
      archival.map((assertion) => [assertion.id, assertion]),
    );
    for (const retraction of artifact.writes.identityRetractions) {
      expect(committedById.get(retraction.id)?.validTo).toBe(
        retraction.validTo,
      );
    }
    for (const assertion of artifact.writes.identityAssertions) {
      expect(committedById.get(assertion.id)).toEqual(assertion);
    }
    expect(committedById.get(baseSame.assertion.id)?.validTo).toBe(
      retractedSame.validTo,
    );
    expect(committedById.get(baseDifferent.assertion.id)?.validTo).toBe(
      retractedDifferent.validTo,
    );
    expect(committedById.get(baseOnly.assertion.id)?.validTo).toBe(
      retractedOnly.validTo,
    );
    expect(
      committedById.get(replacementDifferent.assertion.id)?.validFrom,
    ).toBe(replacementDifferent.assertion.validFrom);
    expect(committedById.get(replacementSame.assertion.id)?.validFrom).toBe(
      replacementSame.assertion.validFrom,
    );
  });

  it.each([
    ["same", "different"],
    ["different", "same"],
  ] as const)(
    "keeps an incremental %s-to-%s replacement idempotent",
    async (initialRelation, replacementRelation) => {
      const [forkPoint] = await createStoreWithSchema(
        graph,
        await makeBackend(),
        { revisionTracking: true },
      );
      const first = await forkPoint.nodes.Person.create(
        { name: "Replay first" },
        { id: `replay-${initialRelation}-first` },
      );
      const second = await forkPoint.nodes.Person.create(
        { name: "Replay second" },
        { id: `replay-${initialRelation}-second` },
      );
      const initial =
        initialRelation === "same" ?
          await forkPoint.identity.assertSame(first, second)
        : await forkPoint.identity.assertDifferent(first, second);
      const target = unwrap(
        await branch(forkPoint, () => makeBackend(), {
          id: asBranchId(`target-${initialRelation}`),
        }),
      ).store;
      const source = unwrap(
        await branch(forkPoint, () => makeBackend(), {
          id: asBranchId(`source-${initialRelation}`),
        }),
      );
      const retraction = requireDefined(
        await source.store.identity.retractAssertion(initial.assertion.id),
      );
      const replacement =
        replacementRelation === "same" ?
          await source.store.identity.assertSame(first, second)
        : await source.store.identity.assertDifferent(first, second);
      const args = {
        forkPoint,
        target,
        branches: [source],
        options: { branchOrder: [source.id] },
      } as const;

      const firstMerge = unwrap(await mergeIncremental(args));
      expect(firstMerge.merged.identity).toEqual({
        asserted: 1,
        retracted: 1,
      });
      const secondMerge = unwrap(await mergeIncremental(args));
      expect(secondMerge.merged.identity).toEqual({
        asserted: 0,
        retracted: 0,
      });

      const archival = await storeRuntime(target).identityAssertionsAtTarget(
        storeRuntime(target).backend,
        "archival",
      );
      expect(
        archival.find((assertion) => assertion.id === initial.assertion.id)
          ?.validTo,
      ).toBe(retraction.validTo);
      expect(
        archival.find((assertion) => assertion.id === replacement.assertion.id),
      ).toEqual(replacement.assertion);
    },
  );

  it("rejects assertion-free same-id nodes of disjoint kinds at plan time", async () => {
    // Neither branch writes any assertion: the contradiction is entirely
    // DERIVED — same-id folding would join a Person and a Robot that the
    // ontology declares disjoint. The plan-time simulation must see nodes
    // absent from the assertion ledger to catch it.
    const Robot = defineNode("Robot", {
      schema: z.object({ name: z.string() }),
    });
    const disjointGraph = defineGraph({
      id: "identity_merge_disjoint_fold",
      nodes: { Person: { type: Person }, Robot: { type: Robot } },
      edges: {},
      ontology: [disjointWith(Person, Robot)],
      identity: { sameIdAcrossKinds: "fold" },
    });
    const [store] = await createStoreWithSchema(
      disjointGraph,
      await makeBackend(),
    );
    const personBranch = unwrap(await branch(store, () => makeBackend()));
    const robotBranch = unwrap(await branch(store, () => makeBackend()));
    await personBranch.store.nodes.Person.create(
      { name: "Clash" },
      { id: "clash" },
    );
    await robotBranch.store.nodes.Robot.create(
      { name: "Clash" },
      { id: "clash" },
    );

    const result = await merge(store, [personBranch, robotBranch], {});
    expect(isErr(result)).toBe(true);
    if (isOk(result)) throw new Error("Expected identity merge conflict");
    expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
    // Plan-time refusal: nothing reached the target.
    expect(await store.nodes.Person.getById("clash" as never)).toBeUndefined();
    expect(await store.nodes.Robot.getById("clash" as never)).toBeUndefined();
  });

  it("rejects an assertion naming a node another branch deleted (#3)", async () => {
    const { store, first, second } = await createBase();
    const assertBranch = unwrap(await branch(store, () => makeBackend()));
    const deleteBranch = unwrap(await branch(store, () => makeBackend()));
    await assertBranch.store.identity.assertSame(first, second);
    await deleteBranch.store.nodes.Person.delete(second.id);

    const result = await merge(store, [assertBranch, deleteBranch], {});
    expect(isErr(result)).toBe(true);
    if (isOk(result)) throw new Error("Expected identity merge conflict");
    expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
    expect(result.error.code).toBe(IDENTITY_CONFLICT_CODE);
    // The refusal is a PLAN-time decision, so nothing was written and rolled
    // back: the target still holds its pre-merge state.
    expect(await store.nodes.Person.getById(second.id)).toBeDefined();
    expect(await store.identity.assertionsOf(first)).toEqual([]);
  });

  it("rejects a transitive same/different contradiction (#4)", async () => {
    const { store, first, second, third } = await createChainBase();
    // Base already holds same(second, third). One branch chains first onto
    // second; another declares first different from third. No endpoint PAIR
    // collides, but the merged closure would make one class both same and
    // different.
    const chainBranch = unwrap(await branch(store, () => makeBackend()));
    const splitBranch = unwrap(await branch(store, () => makeBackend()));
    await chainBranch.store.identity.assertSame(first, second);
    await splitBranch.store.identity.assertDifferent(first, third);

    const result = await merge(store, [chainBranch, splitBranch], {});
    expect(isErr(result)).toBe(true);
    if (isOk(result)) throw new Error("Expected identity merge conflict");
    expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
    expect(result.error.code).toBe(IDENTITY_CONFLICT_CODE);
  });

  it("merges a different assertion over genuinely separate classes (#4)", async () => {
    const { store, first, second, third, fourth } = await createChainBase();
    const chainBranch = unwrap(await branch(store, () => makeBackend()));
    const splitBranch = unwrap(await branch(store, () => makeBackend()));
    // Same shape as the contradiction above, except the `different` pair names
    // a node OUTSIDE the {first, second, third} class.
    await chainBranch.store.identity.assertSame(first, second);
    await splitBranch.store.identity.assertDifferent(third, fourth);

    const result = await merge(store, [chainBranch, splitBranch], {});
    if (isErr(result)) throw result.error;
    expect(result.data.merged.identity).toEqual({ asserted: 2, retracted: 0 });
    expect(await store.identity.areSame(first, third)).toBe(true);
  });

  it("reports identity counts and survivor-rule drops (#5)", async () => {
    const { store, first, fourth, assertion } = await createChainBase();
    const retractBranch = unwrap(await branch(store, () => makeBackend()));
    const otherBranch = unwrap(await branch(store, () => makeBackend()));
    // One branch retracts the inherited same(second, third) and asserts a fresh
    // pair; the other asserts the SAME fresh pair under its own id, so the
    // survivor rule keeps one and must report the loser. The survivor rule
    // breaks ties by validFrom (earlier wins), so the sleep between the two
    // assertions makes `kept` deterministically the survivor rather than
    // leaving the outcome to be read back and used to derive the loser.
    await retractBranch.store.identity.retractAssertion(assertion.id);
    const kept = await retractBranch.store.identity.assertSame(first, fourth);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const duplicate = await otherBranch.store.identity.assertSame(
      first,
      fourth,
    );

    const result = await merge(store, [retractBranch, otherBranch], {});
    expect(isOk(result)).toBe(true);
    if (isErr(result)) throw new Error(result.error.message);
    expect(result.data.merged.identity).toEqual({ asserted: 1, retracted: 1 });

    const survivingIds = (await store.identity.assertionsOf(first)).map(
      (entry) => entry.id,
    );
    expect(survivingIds).toEqual([kept.assertion.id]);
    expect(result.data.dropped).toEqual([
      {
        kind: "identity",
        id: duplicate.assertion.id,
        reason: DUPLICATE_IDENTITY_ASSERTION_DROP_REASON,
      },
    ]);
  });

  it("binds an assertion to an ontology-retyped survivor (#1)", async () => {
    const [baseStore] = await createStoreWithSchema(
      employeeGraph,
      await makeBackend(),
    );
    const anchor = await baseStore.nodes.Staff.create(
      { name: "Anchor Person", birthDate: "1990-01-01" },
      { id: "anchor" },
    );

    const staffBranch = unwrap(
      await branch(baseStore, () => makeBackend(), { id: BRANCH_A }),
    );
    const employeeBranch = unwrap(
      await branch(baseStore, () => makeBackend(), { id: BRANCH_B }),
    );
    // The cluster is {Staff:s-a, Staff:s-b, Employee:s-b}: similarity fuses the
    // two Staff rows, and the same-id ontology-retype edge pulls in the Employee
    // one. The survivor is the min-id member (Staff, "s-a") — its own kind is NOT
    // the reconciled kind — so the cluster commits as (Employee, "s-a") purely
    // through the retype cascade. An assertion naming the survivor therefore
    // binds only if assertion endpoints go through that cascade too.
    const staffNode = await staffBranch.store.nodes.Staff.create(
      { name: "Anna Rivera", birthDate: "1974-03-09" },
      { id: "s-a" },
    );
    await staffBranch.store.identity.assertSame(staffNode, anchor);
    await employeeBranch.store.nodes.Staff.create(
      { name: "Ana Rivera", birthDate: "1974-03-09" },
      { id: "s-b" },
    );
    await employeeBranch.store.nodes.Employee.create(
      { name: "Ana Rivera", birthDate: "1974-03-09" },
      { id: "s-b" },
    );

    const result = await merge(baseStore, [staffBranch, employeeBranch], {
      reconcileTypes: "ontology",
      resolve: {
        Staff: {
          block: (node) =>
            (node as unknown as { birthDate?: string }).birthDate,
          similarity: { kind: "fulltext", fields: ["name"] },
          threshold: 0.85,
        },
      },
      branchOrder: [BRANCH_A, BRANCH_B],
    });
    if (isErr(result)) throw result.error;

    // The whole cluster committed as ONE Employee row; no Staff row survives at
    // either staged id.
    const employee = { kind: "Employee", id: "s-a" } as const;
    const liveIdsOfKind = async (kind: string): Promise<readonly string[]> => {
      const rows = await enumerateAllNodes(
        getStoreBackend(baseStore),
        baseStore.graphId,
        kind,
      );
      return rows
        .filter((row) => row.deleted_at === undefined)
        .map((row) => row.id)
        .toSorted();
    };
    expect(await liveIdsOfKind("Employee")).toEqual(["s-a"]);
    expect(await liveIdsOfKind("Staff")).toEqual(["anchor"]);

    const applied = await baseStore.identity.assertionsOf(anchor);
    expect(applied).toHaveLength(1);
    expect(
      [requireDefined(applied[0]).a, requireDefined(applied[0]).b].map(
        (endpoint) => `${endpoint.kind}:${endpoint.id}`,
      ),
    ).toContain("Employee:s-a");
    expect(await baseStore.identity.areSame(employee, anchor)).toBe(true);
    expect(
      await baseStore.identity.areSame({ kind: "Staff", id: "s-a" }, anchor),
    ).toBe(false);
  });

  it("merges a single fork that retracts then re-asserts the same pair (#1)", async () => {
    const { store, first, second, assertion } = await createBase(true);
    if (assertion === undefined) throw new Error("Missing base assertion");
    const fork = unwrap(await branch(store, () => makeBackend()));
    // A normal linear edit inside ONE branch: retract the inherited assertion,
    // then re-assert the same pair. This is not a cross-branch race and must apply.
    await fork.store.identity.retractAssertion(assertion.id);
    const reasserted = await fork.store.identity.assertSame(first, second);

    const result = await merge(store, [fork], {});
    expect(isOk(result)).toBe(true);

    // The target ends with exactly the reasserted assertion current — the old id
    // is retracted, the new id wins.
    const current = await store.identity.assertionsOf(first);
    expect(current.map((entry) => entry.id)).toEqual([reasserted.assertion.id]);
    expect(current.map((entry) => entry.id)).not.toContain(assertion.id);
  });

  it("remaps a folded assertion endpoint onto the cluster survivor (#2)", async () => {
    const { backend, baseStore, anchor, branchA, branchB, assertion } =
      await createPatientRemapScenario();
    const result = await merge(
      baseStore,
      [branchA, branchB],
      patientRemapOptions,
    );
    expect(isOk(result)).toBe(true);
    expect(unwrap(result).warnings).toEqual([
      narrowedAssertionWarning(assertion.id),
    ]);

    // The two duplicate patients collapsed to one survivor ("p-ana").
    const rows = await enumerateAllNodes(backend, baseStore.graphId, "Patient");
    const liveIds = rows
      .filter((row) => row.deleted_at === undefined)
      .map((row) => row.id)
      .sort();
    expect(liveIds).toEqual(["anchor", "p-ana"]);

    // The applied assertion references the survivor, not the folded id.
    const assertions = await baseStore.identity.assertionsOf(anchor);
    expect(assertions).toHaveLength(1);
    const [appliedAssertion] = assertions;
    const endpointIds = [
      requireDefined(appliedAssertion).a.id,
      requireDefined(appliedAssertion).b.id,
    ].sort();
    expect(endpointIds).toEqual(["anchor", "p-ana"]);
    const survivorRow = requireDefined(
      rows.find((row) => row.id === "p-ana" && row.deleted_at === undefined),
    );
    expect(requireDefined(appliedAssertion).validFrom).toBe(
      survivorRow.valid_from,
    );
  });

  it("round-trips a narrowing warning through a portable plan", async () => {
    const { baseStore, branchA, branchB, assertion } =
      await createPatientRemapScenario();
    const artifact = unwrap(
      await planMerge(baseStore, [branchA, branchB], patientRemapOptions),
    );
    const expectedWarnings = [narrowedAssertionWarning(assertion.id)];
    expect(artifact.review.warnings).toEqual(expectedWarnings);

    const parsed = JSON.parse(JSON.stringify(artifact)) as typeof artifact;
    const report = unwrap(await applyMergePlan(baseStore, parsed));
    expect(report.warnings).toEqual(expectedWarnings);
  });

  it("rejects opposing relations created by endpoint reconciliation", async () => {
    const backend = await makeBackend();
    const [baseStore] = await createStoreWithSchema(patientGraph, backend);
    const anchor = await baseStore.nodes.Patient.create(
      { name: "Anchor Person", birthDate: "1990-01-01" },
      { id: "anchor" },
    );
    const branchA = unwrap(
      await branch(baseStore, () => makeBackend(), { id: BRANCH_A }),
    );
    const branchB = unwrap(
      await branch(baseStore, () => makeBackend(), { id: BRANCH_B }),
    );
    const anna = await branchA.store.nodes.Patient.create(
      { name: "Anna Rivera", birthDate: "1974-03-09" },
      { id: "p-anna" },
    );
    const ana = await branchB.store.nodes.Patient.create(
      { name: "Ana Rivera", birthDate: "1974-03-09" },
      { id: "p-ana" },
    );
    await branchA.store.identity.assertSame(anna, anchor);
    await branchB.store.identity.assertDifferent(ana, anchor);

    const result = await merge(baseStore, [branchA, branchB], {
      resolve: {
        Patient: {
          block: (node) =>
            (node as unknown as { birthDate?: string }).birthDate,
          similarity: { kind: "fulltext", fields: ["name"] },
          threshold: 0.85,
        },
      },
      branchOrder: [BRANCH_A, BRANCH_B],
    });

    expect(isErr(result)).toBe(true);
    if (isOk(result)) throw new Error("Expected identity merge conflict");
    expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
  });

  it("rejects a different assertion collapsed to one reconciled survivor", async () => {
    const backend = await makeBackend();
    const [baseStore] = await createStoreWithSchema(patientGraph, backend);
    const branchA = unwrap(
      await branch(baseStore, () => makeBackend(), { id: BRANCH_A }),
    );
    const anna = await branchA.store.nodes.Patient.create(
      { name: "Anna Rivera", birthDate: "1974-03-09" },
      { id: "p-anna" },
    );
    const ana = await branchA.store.nodes.Patient.create(
      { name: "Ana Rivera", birthDate: "1974-03-09" },
      { id: "p-ana" },
    );
    await branchA.store.identity.assertDifferent(anna, ana);

    const result = await merge(baseStore, [branchA], {
      resolve: {
        Patient: {
          block: (node) =>
            (node as unknown as { birthDate?: string }).birthDate,
          similarity: { kind: "fulltext", fields: ["name"] },
          threshold: 0.85,
        },
      },
      branchOrder: [BRANCH_A],
    });

    expect(isErr(result)).toBe(true);
    if (isOk(result)) throw new Error("Expected identity merge conflict");
    expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
  });

  it("drops a same assertion collapsed to one reconciled survivor (#5)", async () => {
    const backend = await makeBackend();
    const [baseStore] = await createStoreWithSchema(patientGraph, backend);
    const branchA = unwrap(
      await branch(baseStore, () => makeBackend(), { id: BRANCH_A }),
    );
    const anna = await branchA.store.nodes.Patient.create(
      { name: "Anna Rivera", birthDate: "1974-03-09" },
      { id: "p-anna" },
    );
    const ana = await branchA.store.nodes.Patient.create(
      { name: "Ana Rivera", birthDate: "1974-03-09" },
      { id: "p-ana" },
    );
    // Reconciliation folds both endpoints onto one survivor, so "these two are
    // the same" becomes vacuous. Unlike the `different` case above that is not a
    // contradiction — the merge applies, and the report says what it dropped.
    const { assertion } = await branchA.store.identity.assertSame(anna, ana);

    const result = await merge(baseStore, [branchA], {
      resolve: {
        Patient: {
          block: (node) =>
            (node as unknown as { birthDate?: string }).birthDate,
          similarity: { kind: "fulltext", fields: ["name"] },
          threshold: 0.85,
        },
      },
      branchOrder: [BRANCH_A],
    });

    if (isErr(result)) throw result.error;
    expect(result.data.merged.identity).toEqual({ asserted: 0, retracted: 0 });
    expect(result.data.dropped).toEqual([
      {
        kind: "identity",
        id: assertion.id,
        reason: REDUNDANT_IDENTITY_ASSERTION_DROP_REASON,
      },
    ]);
  });

  it("rejects a merge when the target's identity changed after the fork (#4)", async () => {
    const { store, first, second } = await createBase();
    const fork = unwrap(await branch(store, () => makeBackend()));

    // Target-side identity mutation between the fork and the merge: this moves the
    // base@V content token, so the stale branch must be rejected.
    await store.identity.assertSame(first, second);

    const stale = await merge(store, [fork], {});
    expect(isErr(stale)).toBe(true);
    if (isOk(stale)) throw new Error("Expected a base version mismatch");
    expect(stale.error).toBeInstanceOf(BaseVersionMismatchError);

    // Re-forking after the target change captures the new base@V and merges cleanly.
    const refork = unwrap(await branch(store, () => makeBackend()));
    expect(isOk(await merge(store, [refork], {}))).toBe(true);
  });

  it("captures a merge-created identity assertion in recorded time (#6)", async () => {
    const [store] = await createStoreWithSchema(graph, await makeBackend(), {
      history: true,
    });
    const first = await store.nodes.Person.create(
      { name: "First" },
      { id: "first" },
    );
    const second = await store.nodes.Person.create(
      { name: "Second" },
      { id: "second" },
    );
    const fork = unwrap(await branch(store, () => makeBackend()));
    const created = await fork.store.identity.assertSame(first, second);

    expect(isOk(await merge(store, [fork], {}))).toBe(true);

    // A recorded checkpoint taken AFTER the merge must reconstruct the merge-created
    // assertion — the asOfRecorded read draws from the recorded identity relation,
    // so its presence proves both the recorded row and its visibility.
    const checkpoint = await store.recordedNow();
    if (checkpoint === undefined) {
      throw new Error("Expected a recorded checkpoint after the merge");
    }
    const recalled = await store
      .asOfRecorded(checkpoint)
      .identity.assertionsOf(first);
    expect(recalled.map((entry) => entry.id)).toContain(created.assertion.id);
  });
});

/** A branch-tagged assertion, as `stageBranches` produces. */
type StagedAssertion = Readonly<{
  branchId: BranchId;
  assertion: IdentityTransferAssertion;
}>;

/**
 * An otherwise-empty {@link StagingSet} carrying only identity changes — the
 * fixture for the branch-provenance rules `planIdentityChanges` enforces, which
 * are not all reachable through the public store API (the identity service
 * returns the EXISTING assertion for a pair that is still current, so a branch
 * cannot mint a second id for a pair it has not itself retracted).
 */
function stagingWithIdentityChanges(
  newAssertions: readonly StagedAssertion[],
  retractedAssertions: readonly StagedAssertion[] = [],
): StagingSet {
  return {
    newNodesByKind: new Map(),
    modifiedNodes: [],
    deletedNodes: [],
    newEdgesByKind: new Map(),
    modifiedEdges: [],
    deletedEdges: [],
    windowedNodes: [],
    windowedEdges: [],
    newIdentityAssertions: newAssertions,
    // These fixtures stage no node deletion, so every retraction in them is a
    // branch's own act — the cause a real diff would derive for it.
    retractedIdentityAssertions: retractedAssertions.map((staged) => ({
      ...staged,
      cause: { kind: "explicit" } as const,
    })),
    baseIdentityAssertions: retractedAssertions.map(
      (staged) => staged.assertion,
    ),
    targetNodeVersions: new Map(),
    targetEdgeSignatures: new Map(),
  };
}

const SAME_PAIR = {
  relation: "same",
  a: { kind: "Person", id: "first" },
  b: { kind: "Person", id: "second" },
  validFrom: "2024-01-01T00:00:00.000Z",
} as const;

describe("planIdentityChanges retract/reassert rules", () => {
  const inherited: IdentityTransferAssertion = { ...SAME_PAIR, id: "a-1" };
  const reasserted: IdentityTransferAssertion = { ...SAME_PAIR, id: "a-2" };

  it("rejects a reassert by a branch that did not retract the pair", () => {
    // The true race: branch A ended the assertion, branch B re-asserted the same
    // pair under a new id while still holding the old one as current. The
    // branches disagree about whether the pair is asserted at all.
    expect(() =>
      planIdentityChanges(
        stagingWithIdentityChanges(
          [{ branchId: BRANCH_B, assertion: reasserted }],
          [{ branchId: BRANCH_A, assertion: inherited }],
        ),
        new Map(),
      ),
    ).toThrow(IdentityMergeConflictError);
  });

  it("accepts a reassert by a branch that retracted the pair itself", () => {
    // Convergent: branch B retracted the inherited assertion before re-asserting,
    // so both branches agree the old id dies.
    const planned = planIdentityChanges(
      stagingWithIdentityChanges(
        [{ branchId: BRANCH_B, assertion: reasserted }],
        [
          { branchId: BRANCH_A, assertion: inherited },
          { branchId: BRANCH_B, assertion: inherited },
        ],
      ),
      new Map(),
    );

    expect(planned.retractions.map((entry) => entry.id)).toEqual([
      inherited.id,
    ]);
    expect(planned.assertions.map((entry) => entry.id)).toEqual([
      reasserted.id,
    ]);
    expect(planned.dropped).toEqual([]);
  });

  it("accepts a single branch that retracts then re-asserts the pair", () => {
    const planned = planIdentityChanges(
      stagingWithIdentityChanges(
        [{ branchId: BRANCH_A, assertion: reasserted }],
        [{ branchId: BRANCH_A, assertion: inherited }],
      ),
      new Map(),
    );

    expect(planned.retractions.map((entry) => entry.id)).toEqual([
      inherited.id,
    ]);
    expect(planned.assertions.map((entry) => entry.id)).toEqual([
      reasserted.id,
    ]);
  });
});

describe("planIdentityChanges survivor tie-break", () => {
  it("breaks an equal-validFrom tie by the code-point-smallest assertion id", () => {
    const validFrom = "2024-01-01T00:00:00.000Z";
    const base = {
      relation: "same",
      a: { kind: "Person", id: "x" },
      b: { kind: "Person", id: "y" },
      validFrom,
    } as const;
    // "z10" < "z2" in code-point order ('1' (0x31) precedes '2' (0x32)) even
    // though 10 > 2 numerically, so "z10" must survive regardless of input order.
    const shortId: IdentityTransferAssertion = { ...base, id: "z2" };
    const longId: IdentityTransferAssertion = { ...base, id: "z10" };

    const forward = planIdentityChanges(
      stagingWithIdentityChanges([
        { branchId: BRANCH_A, assertion: shortId },
        { branchId: BRANCH_B, assertion: longId },
      ]),
      new Map(),
    );
    const reverse = planIdentityChanges(
      stagingWithIdentityChanges([
        { branchId: BRANCH_B, assertion: longId },
        { branchId: BRANCH_A, assertion: shortId },
      ]),
      new Map(),
    );

    expect(forward.assertions.map((entry) => entry.id)).toEqual(["z10"]);
    expect(reverse.assertions.map((entry) => entry.id)).toEqual(["z10"]);
    // The loser is reported, not silently discarded.
    expect(forward.dropped).toEqual([
      {
        kind: "identity",
        id: "z2",
        reason: DUPLICATE_IDENTITY_ASSERTION_DROP_REASON,
      },
    ]);
    expect(reverse.dropped).toEqual(forward.dropped);
  });
});

describe("plan-time derived identity contradictions", () => {
  const EMPTY_MAP = new Map<never, never>();
  const noDisjoint = { sameIdAcrossKinds: undefined, areDisjoint: () => false };

  it("rejects a different pair that same-id folding makes implicitly identical", () => {
    const ledger: IdentityTransferAssertion[] = [
      {
        id: "different-folded",
        relation: "different",
        a: { kind: "Company", id: "shared" },
        b: { kind: "Person", id: "shared" },
        validFrom: "2024-01-01T00:00:00.000Z",
      },
    ];
    expect(() =>
      assertNoContradictoryIdentityClosure(
        ledger,
        [],
        [],
        new Set<MergeKey>(),
        EMPTY_MAP,
        EMPTY_MAP,
        {
          sameIdAcrossKinds: "fold",
          areDisjoint: () => false,
        },

        [],
      ),
    ).toThrow(IdentityMergeConflictError);
    // The identical ledger is fine under "ignore": no implicit union exists.
    expect(() =>
      assertNoContradictoryIdentityClosure(
        ledger,
        [],
        [],
        new Set<MergeKey>(),
        EMPTY_MAP,
        EMPTY_MAP,
        {
          sameIdAcrossKinds: "ignore",
          areDisjoint: () => false,
        },

        [],
      ),
    ).not.toThrow();
  });

  it("rejects a class whose member kinds the ontology declares disjoint", () => {
    const ledger: IdentityTransferAssertion[] = [
      {
        id: "same-into-disjoint",
        relation: "same",
        a: { kind: "Person", id: "a" },
        b: { kind: "Robot", id: "b" },
        validFrom: "2024-01-01T00:00:00.000Z",
      },
    ];
    expect(() =>
      assertNoContradictoryIdentityClosure(
        ledger,
        [],
        [],
        new Set<MergeKey>(),
        EMPTY_MAP,
        EMPTY_MAP,
        {
          sameIdAcrossKinds: undefined,
          areDisjoint: (left, right) =>
            new Set([left, right]).size === 2 &&
            new Set([left, right, "Person", "Robot"]).size === 2,
        },

        [],
      ),
    ).toThrow(IdentityMergeConflictError);
    expect(() =>
      assertNoContradictoryIdentityClosure(
        ledger,
        [],
        [],
        new Set<MergeKey>(),
        EMPTY_MAP,
        EMPTY_MAP,
        noDisjoint,
        [],
      ),
    ).not.toThrow();
  });

  it("preserves insertion order in ontology-conflict details after rollback", () => {
    const earlierClass: IdentityTransferAssertion = {
      id: "earlier-class",
      relation: "same",
      a: { kind: "Gamma", id: "z" },
      b: { kind: "Alpha", id: "m" },
      validFrom: "2020-01-01T00:00:00.000Z",
      validTo: "2022-01-01T00:00:00.000Z",
    };
    const laterConflict: IdentityTransferAssertion = {
      id: "later-conflict",
      relation: "same",
      a: earlierClass.a,
      b: { kind: "Zed", id: "a" },
      validFrom: requireDefined(earlierClass.validTo),
    };
    let thrown: unknown;

    try {
      assertNoContradictoryIdentityClosure(
        [earlierClass, laterConflict],
        [],
        [],
        new Set<MergeKey>(),
        EMPTY_MAP,
        EMPTY_MAP,
        {
          sameIdAcrossKinds: undefined,
          areDisjoint: (left, right) =>
            new Set([left, right, "Gamma", "Zed"]).size === 2,
        },
        [],
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(IdentityMergeConflictError);
    if (!(thrown instanceof IdentityMergeConflictError)) throw thrown;
    expect(thrown.details).toEqual({
      disjointKinds: ["Gamma", "Zed"],
      sameClass: [
        { kind: "Zed", id: "a" },
        { kind: "Gamma", id: "z" },
      ],
    });
  });

  it("rejects overlapping historical truth and accepts adjacent windows", () => {
    const same: IdentityTransferAssertion = {
      id: "historical-same",
      relation: "same",
      a: { kind: "Person", id: "a" },
      b: { kind: "Person", id: "b" },
      validFrom: "2020-01-01T00:00:00.000Z",
      validTo: "2022-01-01T00:00:00.000Z",
    };
    const different: IdentityTransferAssertion = {
      id: "historical-different",
      relation: "different",
      a: same.a,
      b: same.b,
      validFrom: "2021-01-01T00:00:00.000Z",
      validTo: "2023-01-01T00:00:00.000Z",
    };
    const check = (assertions: readonly IdentityTransferAssertion[]): void =>
      assertNoContradictoryIdentityClosure(
        assertions,
        [],
        [],
        new Set<MergeKey>(),
        EMPTY_MAP,
        EMPTY_MAP,
        noDisjoint,
        [],
      );

    expect(() => check([same, different])).toThrow(IdentityMergeConflictError);
    const adjacent = {
      ...different,
      validFrom: requireDefined(same.validTo),
    };
    expect(() => check([same, adjacent])).not.toThrow();

    expect(() =>
      planIdentityChanges(
        stagingWithIdentityChanges([
          { branchId: BRANCH_A, assertion: same },
          { branchId: BRANCH_B, assertion: different },
        ]),
        new Map(),
      ),
    ).toThrow(IdentityMergeConflictError);
    const planned = planIdentityChanges(
      stagingWithIdentityChanges([
        { branchId: BRANCH_A, assertion: same },
        { branchId: BRANCH_B, assertion: adjacent },
        {
          branchId: BRANCH_B,
          assertion: {
            ...same,
            id: "later-historical-same",
            validFrom: requireDefined(adjacent.validTo),
            validTo: "2024-01-01T00:00:00.000Z",
          },
        },
      ]),
      new Map(),
    );
    expect(
      planned.assertions.map((assertion) => assertion.id).toSorted(),
    ).toEqual([
      "historical-different",
      "historical-same",
      "later-historical-same",
    ]);
  });

  it("removes expired same links before checking later negative truth", () => {
    const bridge: IdentityTransferAssertion = {
      id: "expired-bridge",
      relation: "same",
      a: { kind: "Person", id: "a" },
      b: { kind: "Person", id: "b" },
      validFrom: "2020-01-01T00:00:00.000Z",
      validTo: "2022-01-01T00:00:00.000Z",
    };
    const remainingLink: IdentityTransferAssertion = {
      id: "remaining-link",
      relation: "same",
      a: bridge.b,
      b: { kind: "Person", id: "c" },
      validFrom: "2021-01-01T00:00:00.000Z",
      validTo: "2024-01-01T00:00:00.000Z",
    };
    const laterDifferent: IdentityTransferAssertion = {
      id: "later-different",
      relation: "different",
      a: bridge.a,
      b: remainingLink.b,
      validFrom: requireDefined(bridge.validTo),
      validTo: "2023-01-01T00:00:00.000Z",
    };
    const check = (assertions: readonly IdentityTransferAssertion[]): void =>
      assertNoContradictoryIdentityClosure(
        assertions,
        [],
        [],
        new Set<MergeKey>(),
        EMPTY_MAP,
        EMPTY_MAP,
        noDisjoint,
        [],
      );

    expect(() => check([bridge, remainingLink, laterDifferent])).not.toThrow();
    expect(() =>
      check([
        bridge,
        remainingLink,
        {
          ...laterDifferent,
          validFrom: "2021-06-01T00:00:00.000Z",
        },
      ]),
    ).toThrow(IdentityMergeConflictError);
  });

  it("detects contradictions regardless of which relation spans the window", () => {
    const same: IdentityTransferAssertion = {
      id: "spanning-same",
      relation: "same",
      a: { kind: "Person", id: "a" },
      b: { kind: "Person", id: "b" },
      validFrom: "2020-01-01T00:00:00.000Z",
      validTo: "2024-01-01T00:00:00.000Z",
    };
    const different: IdentityTransferAssertion = {
      ...same,
      id: "nested-different",
      relation: "different",
      validFrom: "2021-01-01T00:00:00.000Z",
      validTo: "2022-01-01T00:00:00.000Z",
    };
    const check = (assertions: readonly IdentityTransferAssertion[]): void =>
      assertNoContradictoryIdentityClosure(
        assertions,
        [],
        [],
        new Set<MergeKey>(),
        EMPTY_MAP,
        EMPTY_MAP,
        noDisjoint,
        [],
      );

    expect(() => check([same, different])).toThrow(IdentityMergeConflictError);
    expect(() =>
      check([
        { ...same, validFrom: different.validFrom, validTo: different.validTo },
        { ...different, validFrom: same.validFrom, validTo: same.validTo },
      ]),
    ).toThrow(IdentityMergeConflictError);
  });

  it("folds same-id references only while their assertion windows overlap", () => {
    const companyReference: IdentityTransferAssertion = {
      id: "company-reference",
      relation: "same",
      a: { kind: "Company", id: "shared" },
      b: { kind: "Company", id: "company-peer" },
      validFrom: "2020-01-01T00:00:00.000Z",
      validTo: "2022-01-01T00:00:00.000Z",
    };
    const personReference: IdentityTransferAssertion = {
      id: "person-reference",
      relation: "same",
      a: { kind: "Person", id: "shared" },
      b: { kind: "Person", id: "person-peer" },
      validFrom: requireDefined(companyReference.validTo),
      validTo: "2024-01-01T00:00:00.000Z",
    };
    const check = (assertions: readonly IdentityTransferAssertion[]): void =>
      assertNoContradictoryIdentityClosure(
        assertions,
        [],
        [],
        new Set<MergeKey>(),
        EMPTY_MAP,
        EMPTY_MAP,
        {
          sameIdAcrossKinds: "fold",
          areDisjoint: (left, right) =>
            new Set([left, right, "Company", "Person"]).size === 2,
        },
        [],
      );

    expect(() => check([companyReference, personReference])).not.toThrow();
    expect(() =>
      check([
        companyReference,
        {
          ...personReference,
          validFrom: "2021-01-01T00:00:00.000Z",
        },
      ]),
    ).toThrow(IdentityMergeConflictError);
  });

  it("does not repeat ontology work for every temporal boundary", () => {
    let disjointChecks = 0;
    const assertions = Array.from(
      { length: 600 },
      (_unused, index): IdentityTransferAssertion => ({
        id: `window-${index}`,
        relation: "same",
        a: { kind: "Company", id: `company-${index}` },
        b: { kind: "Person", id: `person-${index}` },
        validFrom: new Date(index * 2000).toISOString(),
        validTo: new Date(index * 2000 + 1000).toISOString(),
      }),
    );

    expect(() =>
      assertNoContradictoryIdentityClosure(
        assertions,
        [],
        [],
        new Set<MergeKey>(),
        EMPTY_MAP,
        EMPTY_MAP,
        {
          sameIdAcrossKinds: "ignore",
          areDisjoint: () => {
            disjointChecks += 1;
            return false;
          },
        },
        [],
      ),
    ).not.toThrow();
    expect(disjointChecks).toBeLessThan(10);
  });
});

describe("remapIdentityAssertionEndpoints committed precedence", () => {
  it("keeps the target's committed row when canonicalization collides pairs", () => {
    // The branch pair (x1, x2) canonicalizes onto the target pair (a1, a2),
    // colliding with the target's COMMITTED z-target row only AFTER the
    // remap. The post-remap dedupe must re-derive committed precedence from
    // the stored rows — by id/validity order the challenger would win, and
    // the idempotent applier would then write nothing while the report
    // claimed the challenger applied and the committed row dropped.
    const committed: IdentityTransferAssertion = {
      id: "z-target",
      relation: "same",
      a: { kind: "Person", id: "a1" },
      b: { kind: "Person", id: "a2" },
      validFrom: "2024-01-01T00:00:00.000Z",
    };
    const challenger: IdentityTransferAssertion = {
      id: "a-branch",
      relation: "same",
      a: { kind: "Person", id: "x1" },
      b: { kind: "Person", id: "x2" },
      validFrom: "2024-01-01T00:00:00.000Z",
    };
    const canonicalOf = new Map([
      [mergeKey("Person", "x1"), mergeKey("Person", "a1")],
      [mergeKey("Person", "x2"), mergeKey("Person", "a2")],
    ]);
    const remapped = remapIdentityAssertionEndpoints(
      [challenger, committed],
      canonicalOf,
      new Map<MergeKey, string>(),
      new Map([["z-target", committed]]),
    );
    expect(remapped.assertions.map((entry) => entry.id)).toEqual(["z-target"]);
    expect(remapped.dropped).toContainEqual({
      kind: "identity",
      id: "a-branch",
      reason: DUPLICATE_IDENTITY_ASSERTION_DROP_REASON,
    });
  });
});

describe("remapIdentityAssertionEndpoints committed endpoints", () => {
  it("refuses when canonicalization moves a committed row's own endpoints", () => {
    // The applier cannot rewrite a stored row, so a plan carrying committed
    // z-target with canonicalized endpoints could only end as a confusing
    // one-truth refusal — or, if a challenger won the dedupe, a report/ledger
    // divergence. The remap must refuse with the specific cause.
    const committed: IdentityTransferAssertion = {
      id: "z-target",
      relation: "same",
      a: { kind: "Person", id: "x" },
      b: { kind: "Person", id: "z" },
      validFrom: "2024-01-01T00:00:00.000Z",
    };
    expect(() =>
      remapIdentityAssertionEndpoints(
        [committed],
        new Map([[mergeKey("Person", "x"), mergeKey("Person", "y")]]),
        new Map<MergeKey, string>(),
        new Map([["z-target", committed]]),
      ),
    ).toThrow(IdentityMergeConflictError);
  });
});

describe("remapIdentityAssertionEndpoints validity", () => {
  const assertion: IdentityTransferAssertion = {
    id: "branch-assertion",
    relation: "same",
    a: { kind: "Person", id: "folded" },
    b: { kind: "Person", id: "anchor" },
    validFrom: "2020-01-01T00:00:00.000Z",
    validTo: "2025-01-01T00:00:00.000Z",
  };
  const canonicalOf = new Map([
    [mergeKey("Person", "folded"), mergeKey("Person", "survivor")],
  ]);

  it("intersects a remapped assertion with the survivor window", () => {
    const result = remapIdentityAssertionEndpoints(
      [assertion],
      canonicalOf,
      new Map<MergeKey, string>(),
      new Map(),
      new Map([
        [
          mergeKey("Person", "survivor"),
          {
            validFrom: "2022-01-01T00:00:00.000Z",
            validTo: "2024-01-01T00:00:00.000Z",
          },
        ],
      ]),
    );

    expect(result.assertions).toEqual([
      {
        ...assertion,
        a: { kind: "Person", id: "anchor" },
        b: { kind: "Person", id: "survivor" },
        validFrom: "2022-01-01T00:00:00.000Z",
        validTo: "2024-01-01T00:00:00.000Z",
      },
    ]);
    expect(result.dropped).toEqual([]);
    expect(result.warnings).toEqual([
      'Identity assertion "branch-assertion" was narrowed from [2020-01-01T00:00:00.000Z, 2025-01-01T00:00:00.000Z) to [2022-01-01T00:00:00.000Z, 2024-01-01T00:00:00.000Z) to fit its remapped endpoint windows.',
    ]);
  });

  it("drops a remapped assertion with no shared validity window", () => {
    const result = remapIdentityAssertionEndpoints(
      [assertion],
      canonicalOf,
      new Map<MergeKey, string>(),
      new Map(),
      new Map([
        [
          mergeKey("Person", "survivor"),
          { validFrom: "2025-01-01T00:00:00.000Z" },
        ],
      ]),
    );

    expect(result.assertions).toEqual([]);
    expect(result.dropped).toEqual([
      {
        kind: "identity",
        id: assertion.id,
        reason: EMPTY_REMAPPED_IDENTITY_WINDOW_DROP_REASON,
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("honors a survivor window with only an upper bound", () => {
    const result = remapIdentityAssertionEndpoints(
      [assertion],
      canonicalOf,
      new Map<MergeKey, string>(),
      new Map(),
      new Map([
        [
          mergeKey("Person", "survivor"),
          { validTo: "2023-01-01T00:00:00.000Z" },
        ],
      ]),
    );

    expect(result.assertions).toEqual([
      {
        ...assertion,
        a: { kind: "Person", id: "anchor" },
        b: { kind: "Person", id: "survivor" },
        validTo: "2023-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("does not warn for a narrowed assertion removed by dedupe", () => {
    const survivor: IdentityTransferAssertion = {
      ...assertion,
      id: "a-survivor",
      a: { kind: "Person", id: "survivor" },
      validFrom: "2022-01-01T00:00:00.000Z",
      validTo: "2024-01-01T00:00:00.000Z",
    };
    const narrowedLoser = { ...assertion, id: "z-narrowed-loser" };
    const result = remapIdentityAssertionEndpoints(
      [narrowedLoser, survivor],
      canonicalOf,
      new Map<MergeKey, string>(),
      new Map(),
      new Map([
        [
          mergeKey("Person", "survivor"),
          {
            validFrom: "2022-01-01T00:00:00.000Z",
            validTo: "2024-01-01T00:00:00.000Z",
          },
        ],
      ]),
    );

    expect(result.assertions.map((entry) => entry.id)).toEqual([survivor.id]);
    expect(result.dropped).toContainEqual({
      kind: "identity",
      id: narrowedLoser.id,
      reason: DUPLICATE_IDENTITY_ASSERTION_DROP_REASON,
    });
    expect(result.warnings).toEqual([]);
  });

  it("orders warnings by the surviving assertions' semantic keys", () => {
    const laterSemanticKey: IdentityTransferAssertion = {
      id: "a-warning",
      relation: "same",
      a: { kind: "Person", id: "z-first" },
      b: { kind: "Person", id: "z-second" },
      validFrom: "2020-01-01T00:00:00.000Z",
      validTo: "2025-01-01T00:00:00.000Z",
    };
    const earlierSemanticKey: IdentityTransferAssertion = {
      ...laterSemanticKey,
      id: "z-warning",
      a: { kind: "Person", id: "a-first" },
      b: { kind: "Person", id: "a-second" },
    };
    const result = remapIdentityAssertionEndpoints(
      [laterSemanticKey, earlierSemanticKey],
      new Map(),
      new Map(),
      new Map(),
      new Map([
        [
          mergeKey("Person", "z-first"),
          { validFrom: "2023-01-01T00:00:00.000Z" },
        ],
        [
          mergeKey("Person", "a-first"),
          { validFrom: "2022-01-01T00:00:00.000Z" },
        ],
      ]),
    );

    expect(result.warnings).toEqual([
      'Identity assertion "z-warning" was narrowed from [2020-01-01T00:00:00.000Z, 2025-01-01T00:00:00.000Z) to [2022-01-01T00:00:00.000Z, 2025-01-01T00:00:00.000Z) to fit its remapped endpoint windows.',
      'Identity assertion "a-warning" was narrowed from [2020-01-01T00:00:00.000Z, 2025-01-01T00:00:00.000Z) to [2023-01-01T00:00:00.000Z, 2025-01-01T00:00:00.000Z) to fit its remapped endpoint windows.',
    ]);
  });
});

describe("translateIdentityCommitError", () => {
  it("translates identity refusals into the typed conflict, cause preserved", () => {
    const contradiction = new IdentityContradictionError({
      operation: "import",
      a: { kind: "Person", id: "a" },
      b: { kind: "Person", id: "b" },
      reason: "different-assertion",
    });
    const translated = translateIdentityCommitError(contradiction);
    expect(translated).toBeInstanceOf(IdentityMergeConflictError);
    expect((translated as Error).cause).toBe(contradiction);

    const importConflict = new ConfigurationError(
      "Identity assertion id x already identifies different truth.",
      { code: "IDENTITY_IMPORT_ID_CONFLICT" },
    );
    expect(translateIdentityCommitError(importConflict)).toBeInstanceOf(
      IdentityMergeConflictError,
    );

    // The transfer validator reports per-assertion issues — the identity code
    // lives in details.issues[].code, never at the top level.
    const validation = new ValidationError("Identity transfer failed.", {
      issues: [
        {
          path: "identity.assertions[0]",
          message: "future validFrom",
          code: "IDENTITY_IMPORT_FUTURE_VALID_FROM",
        },
      ],
    });
    expect(translateIdentityCommitError(validation)).toBeInstanceOf(
      IdentityMergeConflictError,
    );

    // At the identity-applier boundary a missing node can only be a vanished
    // assertion endpoint.
    const missingEndpoint = new NodeNotFoundError("Person", "gone");
    expect(translateIdentityCommitError(missingEndpoint)).toBeInstanceOf(
      IdentityMergeConflictError,
    );
  });

  it("passes through merge errors, environment codes, and foreign failures", () => {
    // A typed merge refusal (a guard's own error) must keep its exact type —
    // wrapping it would strip the replan signal.
    const alreadyTyped = new BaseVersionMismatchError("window drift", {});
    expect(translateIdentityCommitError(alreadyTyped)).toBe(alreadyTyped);
    // Environment problems are not statements about identity truth.
    const environment = new ConfigurationError(
      "Cannot apply identity merge changes to an identity-disabled graph.",
      { code: "IDENTITY_MERGE_REQUIRES_PROFILE" },
    );
    expect(translateIdentityCommitError(environment)).toBe(environment);
    const foreign = new Error("disk full");
    expect(translateIdentityCommitError(foreign)).toBe(foreign);
  });
});
