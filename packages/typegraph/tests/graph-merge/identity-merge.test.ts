import type { GraphBackend } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import {
  BaseVersionMismatchError,
  IdentityMergeConflictError,
} from "../../src/graph-merge/errors";
import { merge, planIdentityChanges } from "../../src/graph-merge/merge";
import { isErr, isOk, unwrap } from "../../src/graph-merge/result";
import type { StagingSet } from "../../src/graph-merge/staging";
import { stageBranches } from "../../src/graph-merge/staging";
import { enumerateAllNodes } from "../../src/graph-merge/state-diff";
import type { IdentityTransferAssertion } from "../../src/graph-merge/typegraph-internal";
import type { BranchId } from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { requireDefined } from "../../src/utils/presence";
import { backendMatrix } from "./test-utils";

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

const BRANCH_A = asBranchId("branch-a");
const BRANCH_B = asBranchId("branch-b");

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
    );
    const reverse = planIdentityChanges(
      await stageBranches(store, [branchB, branchA]),
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

  it("rejects retract/reassert races as a typed merge conflict", async () => {
    const { store, first, second, assertion } = await createBase(true);
    if (assertion === undefined) throw new Error("Missing base assertion");
    const retractBranch = unwrap(await branch(store, () => makeBackend()));
    const reassertBranch = unwrap(await branch(store, () => makeBackend()));
    await retractBranch.store.identity.retractAssertion(assertion.id);
    await reassertBranch.store.identity.retractAssertion(assertion.id);
    await reassertBranch.store.identity.assertSame(first, second);

    const result = await merge(store, [retractBranch, reassertBranch], {});
    expect(isErr(result)).toBe(true);
    if (isOk(result)) throw new Error("Expected identity merge conflict");
    expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
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
    expect(current.map((entry) => entry.id)).toEqual([reasserted.id]);
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
    expect(recalled.map((entry) => entry.id)).toContain(created.id);
  });
});

/** An empty {@link StagingSet} carrying only the given new identity assertions. */
function stagingWithNewAssertions(
  assertions: readonly Readonly<{
    branchId: BranchId;
    assertion: IdentityTransferAssertion;
  }>[],
): StagingSet {
  return {
    newNodesByKind: new Map(),
    modifiedNodes: [],
    deletedNodes: [],
    newEdgesByKind: new Map(),
    modifiedEdges: [],
    deletedEdges: [],
    newIdentityAssertions: assertions,
    retractedIdentityAssertions: [],
    targetNodeVersions: new Map(),
    targetEdgeSignatures: new Map(),
  };
}

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
      stagingWithNewAssertions([
        { branchId: BRANCH_A, assertion: shortId },
        { branchId: BRANCH_B, assertion: longId },
      ]),
    );
    const reverse = planIdentityChanges(
      stagingWithNewAssertions([
        { branchId: BRANCH_B, assertion: longId },
        { branchId: BRANCH_A, assertion: shortId },
      ]),
    );

    expect(forward.assertions.map((entry) => entry.id)).toEqual(["z10"]);
    expect(reverse.assertions.map((entry) => entry.id)).toEqual(["z10"]);
  });
});
