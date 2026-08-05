import type { GraphBackend } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  disjointWith,
  subClassOf,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { merge } from "../../src/graph-merge/merge";
import {
  assertNoContradictoryIdentityClosure,
  DUPLICATE_IDENTITY_ASSERTION_DROP_REASON,
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
import { requireDefined } from "../../src/utils/presence";
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

describe.each(backendMatrix())("identity merge [$name]", (entry) => {
  let cleanups: (() => Promise<void>)[];

  beforeEach(() => {
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
  });

  async function makeBackend(): Promise<GraphBackend> {
    const fixture = await entry.make();
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

    // Branch A's Patient has the LARGER id ("p-anna" > "p-ana"), so it is the
    // NON-survivor. Its identity assertion endpoint must be remapped onto branch
    // B's surviving node, or the commit-time endpoint guard rejects the dangling id.
    const anna = await branchA.store.nodes.Patient.create(
      { name: "Anna Rivera", birthDate: "1974-03-09" },
      { id: "p-anna" },
    );
    await branchA.store.identity.assertSame(anna, anchor);

    await branchB.store.nodes.Patient.create(
      { name: "Ana Rivera", birthDate: "1974-03-09" },
      { id: "p-ana" },
    );

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
    expect(isOk(result)).toBe(true);

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
    newIdentityAssertions: newAssertions,
    retractedIdentityAssertions: retractedAssertions,
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
