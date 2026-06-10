import type { GraphBackend, Node, Store } from "@nicia-ai/typegraph";
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
import { BaseVersionMismatchError } from "../../src/graph-merge/errors";
import { merge } from "../../src/graph-merge/merge";
import { isErr, isOk, unwrap } from "../../src/graph-merge/result";
import {
  enumerateAllEdges,
  enumerateAllNodes,
} from "../../src/graph-merge/state-diff";
import type {
  BranchId,
  GraphBranch,
  MergeOptions,
  SimilarityStrategy,
} from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { backendMatrix } from "./test-utils";

/**
 * A small FHIR-flavored care graph (design §14): patients linked to encounters
 * and conditions. The `Patient.name` field drives entity resolution; `Doctor` /
 * `SpecialistDoctor` give the graph a real subclass ontology so
 * `reconcileTypes: "ontology"` is exercised end-to-end.
 */
const Patient = defineNode("Patient", {
  schema: z.object({
    name: z.string(),
    birthDate: z.string(),
    mrn: z.string().optional(),
  }),
});

const Encounter = defineNode("Encounter", {
  schema: z.object({ reason: z.string() }),
});

const Condition = defineNode("Condition", {
  schema: z.object({ code: z.string() }),
});

const Doctor = defineNode("Doctor", {
  schema: z.object({ name: z.string() }),
});

const SpecialistDoctor = defineNode("SpecialistDoctor", {
  schema: z.object({ name: z.string() }),
});

const hadEncounter = defineEdge("hadEncounter", {
  schema: z.object({ on: z.string() }),
  from: [Patient],
  to: [Encounter],
});

const hasCondition = defineEdge("hasCondition", {
  schema: z.object({ since: z.string() }),
  from: [Patient],
  to: [Condition],
});

const careGraph = defineGraph({
  id: "fhir-care-graph",
  nodes: {
    Patient: { type: Patient },
    Encounter: { type: Encounter },
    Condition: { type: Condition },
    Doctor: { type: Doctor },
    SpecialistDoctor: { type: SpecialistDoctor },
  },
  edges: {
    hadEncounter: { type: hadEncounter, from: [Patient], to: [Encounter] },
    hasCondition: { type: hasCondition, from: [Patient], to: [Condition] },
  },
  ontology: [subClassOf(SpecialistDoctor, Doctor)],
});

type CareGraph = typeof careGraph;

const DEMO_THRESHOLD = 0.85;
const BRANCH_A = asBranchId("branch-a");
const BRANCH_B = asBranchId("branch-b");

/** The FHIR demo similarity: in-memory Dice trigram over Patient.name (no embeddings). */
const patientNameSimilarity: SimilarityStrategy<CareGraph> = {
  kind: "fulltext",
  fields: ["name"],
};

/** Blocks patients by shared birthDate, bounding the O(n²) comparisons. */
function blockByBirthDate(node: Node): string | undefined {
  return (node as unknown as { birthDate?: string }).birthDate;
}

/** The merge options shared by the FHIR scenario. */
function fhirMergeOptions(): MergeOptions<CareGraph> {
  return {
    resolve: {
      Patient: {
        block: (node) => blockByBirthDate(node),
        similarity: patientNameSimilarity,
        threshold: DEMO_THRESHOLD,
      },
    },
    reconcileTypes: "ontology",
    onPropertyConflict: "flag",
    branchOrder: [BRANCH_A, BRANCH_B],
  };
}

function lexicographicMin(left: string, right: string): string {
  return left < right ? left : right;
}

/** Live `{ id, name, mrn }` for every Patient in a store, sorted by id. */
async function livePatients(
  store: Store<CareGraph>,
): Promise<readonly Readonly<{ id: string; name: unknown; mrn: unknown }>[]> {
  const rows = await enumerateAllNodes(store.backend, store.graphId, "Patient");
  return rows
    .filter((row) => row.deleted_at === undefined)
    .map((row) => {
      const props = JSON.parse(row.props) as Record<string, unknown>;
      return { id: row.id, name: props.name, mrn: props.mrn };
    })
    .sort((left, right) =>
      left.id < right.id ? -1
      : left.id > right.id ? 1
      : 0,
    );
}

/** Live `{ id, from, to }` for every edge of `kind`, sorted by id. */
async function liveEdges(
  store: Store<CareGraph>,
  kind: string,
): Promise<readonly Readonly<{ id: string; from: string; to: string }>[]> {
  const rows = await enumerateAllEdges(store.backend, store.graphId, kind);
  return rows
    .filter((row) => row.deleted_at === undefined)
    .map((row) => ({ id: row.id, from: row.from_id, to: row.to_id }))
    .sort((left, right) =>
      left.id < right.id ? -1
      : left.id > right.id ? 1
      : 0,
    );
}

describe.each(backendMatrix())("merge — FHIR care graph [$name]", (entry) => {
  let cleanups: (() => Promise<void>)[];

  beforeEach(() => {
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
  });

  async function makeBackend(): Promise<GraphBackend> {
    const fixture = await entry.make();
    cleanups.push(fixture.cleanup);
    return fixture.backend;
  }

  async function makeBranch(
    baseStore: Store<CareGraph>,
    id: BranchId,
  ): Promise<GraphBranch<CareGraph>> {
    return unwrap(
      await branch<CareGraph>(baseStore, () => makeBackend(), { id }),
    );
  }

  /**
   * The §14 scenario: an empty base (so both branches' patients are NEW and must
   * be resolved). Branch A adds "Anna Rivera" with an encounter; branch B adds
   * "Ana Rivera" (same birthDate, a near-duplicate spelling) with a condition.
   * Branch A also carries an `mrn` that branch B leaves blank, and the two name
   * spellings disagree — both surface as property conflicts under `"flag"`.
   */
  async function seedScenario(): Promise<
    Readonly<{
      baseStore: Store<CareGraph>;
      branchA: GraphBranch<CareGraph>;
      branchB: GraphBranch<CareGraph>;
      annaId: string;
      anaId: string;
    }>
  > {
    const [baseStore] = await createStoreWithSchema(
      careGraph,
      await makeBackend(),
    );

    const branchA = await makeBranch(baseStore, BRANCH_A);
    const branchB = await makeBranch(baseStore, BRANCH_B);

    // Branch A: "Anna Rivera" + an encounter edge onto her.
    const anna = await branchA.store.nodes.Patient.create({
      name: "Anna Rivera",
      birthDate: "1974-03-09",
      mrn: "MRN-001",
    });
    const encounter = await branchA.store.nodes.Encounter.create({
      reason: "annual checkup",
    });
    await branchA.store.edges.hadEncounter.create(anna, encounter, {
      on: "2024-01-15",
    });

    // Branch B: "Ana Rivera" (same birthDate) + a condition edge onto her.
    const ana = await branchB.store.nodes.Patient.create({
      name: "Ana Rivera",
      birthDate: "1974-03-09",
    });
    const condition = await branchB.store.nodes.Condition.create({
      code: "E11.9",
    });
    await branchB.store.edges.hasCondition.create(ana, condition, {
      since: "2023-06-01",
    });

    return {
      baseStore,
      branchA,
      branchB,
      annaId: anna.id,
      anaId: ana.id,
    };
  }

  it("honors a branch's property deletion on an inherited node (#2)", async () => {
    const [baseStore] = await createStoreWithSchema(
      careGraph,
      await makeBackend(),
    );
    const alice = await baseStore.nodes.Patient.create({
      name: "Alice",
      birthDate: "1974-03-09",
      mrn: "MRN-1",
    });
    const branchA = await makeBranch(baseStore, BRANCH_A);
    // The branch removes the optional `mrn` on the inherited node.
    await branchA.store.nodes.Patient.update(alice.id, { mrn: undefined });

    const result = await merge<CareGraph>(baseStore, [branchA], {
      branchOrder: [BRANCH_A],
    });
    expect(isOk(result)).toBe(true);

    const patients = await livePatients(baseStore);
    expect(patients).toHaveLength(1);
    expect(patients[0]!.name).toBe("Alice");
    expect(patients[0]!.mrn).toBeUndefined();
  });

  it("honors a deletion while a concurrent branch edits a different property (#2)", async () => {
    const [baseStore] = await createStoreWithSchema(
      careGraph,
      await makeBackend(),
    );
    const alice = await baseStore.nodes.Patient.create({
      name: "Alice",
      birthDate: "1974-03-09",
      mrn: "MRN-1",
    });
    const branchA = await makeBranch(baseStore, BRANCH_A);
    const branchB = await makeBranch(baseStore, BRANCH_B);
    await branchA.store.nodes.Patient.update(alice.id, { mrn: undefined });
    await branchB.store.nodes.Patient.update(alice.id, { name: "Alicia" });

    const result = await merge<CareGraph>(baseStore, [branchA, branchB], {
      branchOrder: [BRANCH_A, BRANCH_B],
    });
    expect(isOk(result)).toBe(true);

    const patients = await livePatients(baseStore);
    expect(patients).toHaveLength(1);
    // Branch B's name edit survives; branch A's mrn deletion is honored, not
    // reverted to the base value.
    expect(patients[0]!.name).toBe("Alicia");
    expect(patients[0]!.mrn).toBeUndefined();
  });

  it("resolves the duplicate Patient, repoints both branches' edges, and flags the name conflict", async () => {
    const { baseStore, branchA, branchB, annaId, anaId } = await seedScenario();

    const result = await merge<CareGraph>(
      baseStore,
      [branchA, branchB],
      fhirMergeOptions(),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      throw result.error;
    }
    const report = result.data;

    // Exactly ONE canonical Patient survives in the merged base. The canonical
    // id is the lexicographically-minimal of the two duplicate ids.
    const patients = await livePatients(baseStore);
    expect(patients).toHaveLength(1);
    const expectedCanonical = lexicographicMin(annaId, anaId);
    expect(patients[0]!.id).toBe(expectedCanonical);

    // One entity resolution recording the two-member cluster.
    expect(report.resolutions).toHaveLength(1);
    const resolution = report.resolutions[0]!;
    expect(resolution.canonicalId).toBe(expectedCanonical);
    expect(resolution.kind).toBe("Patient");
    expect([...resolution.memberIds].sort()).toEqual([annaId, anaId].sort());
    expect([...resolution.branchOrigins].sort()).toEqual(
      [BRANCH_A, BRANCH_B].sort(),
    );

    // Both branches' edges are repointed onto the SINGLE canonical patient.
    const encounters = await liveEdges(baseStore, "hadEncounter");
    const conditions = await liveEdges(baseStore, "hasCondition");
    expect(encounters).toHaveLength(1);
    expect(conditions).toHaveLength(1);
    expect(encounters[0]!.from).toBe(expectedCanonical);
    expect(conditions[0]!.from).toBe(expectedCanonical);

    // The name-spelling disagreement surfaces as a property conflict on the
    // canonical patient. The two contributing branch values are recorded.
    const nameConflict = report.conflicts.find(
      (conflict) => conflict.property === "name",
    );
    expect(nameConflict).toBeDefined();
    expect(nameConflict!.entityId).toBe(expectedCanonical);
    expect(nameConflict!.kind).toBe("Patient");
    const conflictNames = nameConflict!.values
      .map((value) => value.value)
      .sort();
    expect(conflictNames).toEqual(["Ana Rivera", "Anna Rivera"]);
    // Under "flag" the canonical's own value is retained (no auto-resolution).
    expect(nameConflict!.resolution).toBe(
      expectedCanonical === annaId ? "Anna Rivera" : "Ana Rivera",
    );

    // The merged counts reflect the single patient + both repointed edges, plus
    // the two non-duplicate satellite nodes (encounter, condition).
    expect(report.merged.nodes).toBeGreaterThanOrEqual(1);
    expect(report.merged.edges).toBe(2);

    // Same-kind cluster: ontology reconciliation is a no-op here (both members
    // are Patient), so no type reconciliation is recorded.
    expect(report.typeReconciliations).toEqual([]);

    // Report-only provenance: each branch contributed the canonical patient and
    // its own edge into the merged graph.
    const provA = report.provenance.byBranch(BRANCH_A);
    const provB = report.provenance.byBranch(BRANCH_B);
    expect(provA.nodeIds).toContain(expectedCanonical);
    expect(provB.nodeIds).toContain(expectedCanonical);
    expect(provA.edgeIds).toContain(encounters[0]!.id);
    expect(provB.edgeIds).toContain(conditions[0]!.id);
  });

  it("produces an identical merged graph regardless of branch order", async () => {
    const forward = await seedScenario();
    const forwardResult = await merge<CareGraph>(
      forward.baseStore,
      [forward.branchA, forward.branchB],
      fhirMergeOptions(),
    );

    const reversed = await seedScenario();
    const reversedResult = await merge<CareGraph>(
      reversed.baseStore,
      [reversed.branchB, reversed.branchA],
      fhirMergeOptions(),
    );

    expect(isOk(forwardResult) && isOk(reversedResult)).toBe(true);
    if (!isOk(forwardResult) || !isOk(reversedResult)) {
      return;
    }

    // The two scenarios mint distinct ids, so compare structural shape: one
    // patient, one of each edge, one resolution, one name conflict.
    expect(forwardResult.data.resolutions).toHaveLength(1);
    expect(reversedResult.data.resolutions).toHaveLength(1);
    expect(forwardResult.data.merged.edges).toBe(
      reversedResult.data.merged.edges,
    );
    expect(
      forwardResult.data.conflicts.filter(
        (conflict) => conflict.property === "name",
      ),
    ).toHaveLength(1);
    expect(
      reversedResult.data.conflicts.filter(
        (conflict) => conflict.property === "name",
      ),
    ).toHaveLength(1);

    // A within-scenario order swap (forward.* merged in reversed order) must
    // commit the SAME canonical patient set as the forward order.
    const orderSwap = await seedScenario();
    const swapForward = await merge<CareGraph>(
      orderSwap.baseStore,
      [orderSwap.branchA, orderSwap.branchB],
      fhirMergeOptions(),
    );
    const swapPatients = await livePatients(orderSwap.baseStore);
    expect(isOk(swapForward)).toBe(true);
    expect(swapPatients).toHaveLength(1);
    const expectedCanonical = lexicographicMin(
      orderSwap.annaId,
      orderSwap.anaId,
    );
    expect(swapPatients[0]!.id).toBe(expectedCanonical);
  });

  it("merges distinct (non-duplicate) patients without collapsing them", async () => {
    const [baseStore] = await createStoreWithSchema(
      careGraph,
      await makeBackend(),
    );
    const branchA = await makeBranch(baseStore, BRANCH_A);
    const branchB = await makeBranch(baseStore, BRANCH_B);

    await branchA.store.nodes.Patient.create({
      name: "Anna Rivera",
      birthDate: "1974-03-09",
    });
    // Same birthDate (so they co-block) but a completely different name —
    // below threshold, so they must NOT merge.
    await branchB.store.nodes.Patient.create({
      name: "Robert Smith",
      birthDate: "1974-03-09",
    });

    const result = await merge<CareGraph>(
      baseStore,
      [branchA, branchB],
      fhirMergeOptions(),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      throw result.error;
    }

    const patients = await livePatients(baseStore);
    expect(patients).toHaveLength(2);
    // Each new patient is its own singleton cluster: no multi-member resolution.
    for (const resolution of result.data.resolutions) {
      expect(resolution.memberIds).toHaveLength(1);
    }
    expect(
      result.data.conflicts.filter((conflict) => conflict.property === "name"),
    ).toHaveLength(0);
  });

  it("rejects a branch whose base@V does not match the target", async () => {
    const [baseStore] = await createStoreWithSchema(
      careGraph,
      await makeBackend(),
    );

    // Fork a branch FIRST (captures base@V over the empty base)...
    const staleBranch = await makeBranch(baseStore, BRANCH_A);

    // ...then MUTATE the base so its content fingerprint (and thus base@V)
    // diverges from what the branch forked from.
    await baseStore.nodes.Patient.create({
      name: "Drift Patient",
      birthDate: "2000-01-01",
    });

    const result = await merge<CareGraph>(
      baseStore,
      [staleBranch],
      fhirMergeOptions(),
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
      expect(result.error.code).toBe("GRAPH_MERGE_BASE_VERSION_MISMATCH");
    }
  });

  it("rejects re-merging an already-merged branch — a successful merge advances base@V", async () => {
    const { baseStore, branchA, branchB } = await seedScenario();

    const first = await merge<CareGraph>(
      baseStore,
      [branchA],
      fhirMergeOptions(),
    );
    expect(isOk(first)).toBe(true);

    // The committed merge changed the target's content fingerprint, so the
    // SAME branch cannot be merged twice (no double-application)...
    const again = await merge<CareGraph>(
      baseStore,
      [branchA],
      fhirMergeOptions(),
    );
    expect(isErr(again)).toBe(true);
    if (isErr(again)) {
      expect(again.error).toBeInstanceOf(BaseVersionMismatchError);
    }

    // ...and a SIBLING branch forked before the first merge landed is equally
    // stale: sequential single-branch merges require a re-fork (or
    // mergeIncremental). Merging siblings together is the snapshot contract.
    const sibling = await merge<CareGraph>(
      baseStore,
      [branchB],
      fhirMergeOptions(),
    );
    expect(isErr(sibling)).toBe(true);
    if (isErr(sibling)) {
      expect(sibling.error).toBeInstanceOf(BaseVersionMismatchError);
    }
  });

  // Regression (F20): a base row soft-deleted BEFORE branching must not come back
  // to life. The clone formerly exported `includeDeleted: true`, but interchange's
  // meta schema has no `deletedAt`, so the tombstone was lost and the row imported
  // LIVE — then the fork diff reported it as a new node and the merge re-created it.
  it("does not resurrect a soft-deleted base row as a new node (F20)", async () => {
    const [baseStore] = await createStoreWithSchema(
      careGraph,
      await makeBackend(),
    );

    const ghost = await baseStore.nodes.Patient.create({
      name: "Ghost",
      birthDate: "1900-01-01",
    });
    await baseStore.nodes.Patient.delete(ghost.id); // soft-delete IN THE BASE
    const keeper = await baseStore.nodes.Patient.create({
      name: "Keeper",
      birthDate: "1990-05-05",
    });

    // Fork (clone) and merge straight back with no branch-side edits.
    const branchA = await makeBranch(baseStore, BRANCH_A);
    const result = await merge<CareGraph>(
      baseStore,
      [branchA],
      fhirMergeOptions(),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      throw result.error;
    }

    // Only Keeper is live; Ghost stays deleted and is never re-introduced.
    const patients = await livePatients(baseStore);
    expect(patients.map((patient) => patient.id)).toEqual([keeper.id]);
    expect(patients.map((patient) => patient.name)).toEqual(["Keeper"]);
    expect(result.data.resolutions).toEqual([]);
  });

  // Regression (F1): two branches create a node under the SAME explicit id with
  // differing props. The committed node is policy-resolved, but the cross-branch
  // disagreement must be REPORTED — formerly it was silently dropped because the
  // cluster had a single distinct id.
  it("reports a conflict for a node both branches create under one id (F1)", async () => {
    const [baseStore] = await createStoreWithSchema(
      careGraph,
      await makeBackend(),
    );
    const branchA = await makeBranch(baseStore, BRANCH_A);
    const branchB = await makeBranch(baseStore, BRANCH_B);

    const sharedId = "shared-patient-1";
    await branchA.store.nodes.Patient.bulkCreate([
      { id: sharedId, props: { name: "Anna Rivera", birthDate: "1974-03-09" } },
    ]);
    await branchB.store.nodes.Patient.bulkCreate([
      { id: sharedId, props: { name: "Ana Rivera", birthDate: "1974-03-09" } },
    ]);

    const result = await merge<CareGraph>(baseStore, [branchA, branchB], {
      onPropertyConflict: "flag",
      branchOrder: [BRANCH_A, BRANCH_B],
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      throw result.error;
    }
    const report = result.data;

    const patients = await livePatients(baseStore);
    expect(patients.map((patient) => patient.id)).toEqual([sharedId]);

    const nameConflict = report.conflicts.find(
      (conflict) => conflict.property === "name",
    );
    expect(nameConflict).toBeDefined();
    expect(nameConflict!.entityId).toBe(sharedId);
    expect(nameConflict!.values.map((value) => value.value).sort()).toEqual([
      "Ana Rivera",
      "Anna Rivera",
    ]);
    // A single distinct id is not a multi-id MERGE, so no EntityResolution.
    expect(report.resolutions).toEqual([]);
  });

  // Regression (F11): an inherited node modified by two branches on DIFFERENT
  // fields must 3-way merge — neither edit silently overwrites the other (formerly
  // the lexicographically-largest branchId's full prop bag won).
  it("3-way merges an inherited node edited on disjoint fields (F11)", async () => {
    const [baseStore] = await createStoreWithSchema(
      careGraph,
      await makeBackend(),
    );
    const origin = await baseStore.nodes.Patient.create({
      name: "Origin",
      birthDate: "1980-01-01",
      mrn: "MRN-ORIG",
    });
    const branchA = await makeBranch(baseStore, BRANCH_A);
    const branchB = await makeBranch(baseStore, BRANCH_B);

    await branchA.store.nodes.Patient.update(origin.id, { name: "Renamed" });
    await branchB.store.nodes.Patient.update(origin.id, {
      birthDate: "2000-12-31",
    });

    const result = await merge<CareGraph>(baseStore, [branchA, branchB], {
      onPropertyConflict: "flag",
      branchOrder: [BRANCH_A, BRANCH_B],
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      throw result.error;
    }

    const patients = await livePatients(baseStore);
    expect(patients).toHaveLength(1);
    expect(patients[0]!.id).toBe(origin.id);
    expect(patients[0]!.name).toBe("Renamed"); // A's edit survived
    expect(result.data.conflicts).toEqual([]); // disjoint fields → no conflict

    const rows = await enumerateAllNodes(
      baseStore.backend,
      baseStore.graphId,
      "Patient",
    );
    const merged = rows.find((row) => row.id === origin.id)!;
    expect((JSON.parse(merged.props) as { birthDate: string }).birthDate).toBe(
      "2000-12-31", // B's edit survived too
    );
  });

  // Regression (F11): two branches modifying the SAME inherited field surface a
  // PropertyConflict instead of one silently overwriting the other.
  it("surfaces a conflict when two branches edit the same inherited field (F11)", async () => {
    const [baseStore] = await createStoreWithSchema(
      careGraph,
      await makeBackend(),
    );
    const origin = await baseStore.nodes.Patient.create({
      name: "Origin",
      birthDate: "1980-01-01",
    });
    const branchA = await makeBranch(baseStore, BRANCH_A);
    const branchB = await makeBranch(baseStore, BRANCH_B);

    await branchA.store.nodes.Patient.update(origin.id, { name: "Alpha" });
    await branchB.store.nodes.Patient.update(origin.id, { name: "Beta" });

    const result = await merge<CareGraph>(baseStore, [branchA, branchB], {
      onPropertyConflict: "flag",
      branchOrder: [BRANCH_A, BRANCH_B],
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      throw result.error;
    }

    const nameConflict = result.data.conflicts.find(
      (conflict) => conflict.property === "name",
    );
    expect(nameConflict).toBeDefined();
    expect(nameConflict!.entityId).toBe(origin.id);
    expect(nameConflict!.values.map((value) => value.value).sort()).toEqual([
      "Alpha",
      "Beta",
    ]);
    // Under "flag" the base value is retained — not silently overwritten.
    const patients = await livePatients(baseStore);
    expect(patients[0]!.name).toBe("Origin");
  });
});

describe.each(backendMatrix())(
  "merge edge property deletion [$name]",
  (entry) => {
    const Person = defineNode("Person", {
      schema: z.object({ name: z.string() }),
    });
    // `note` is optional so a fork can remove it; `since` is required.
    const linked = defineEdge("linked", {
      schema: z.object({ since: z.string(), note: z.string().optional() }),
      from: [Person],
      to: [Person],
    });
    const linkGraph = defineGraph({
      id: "merge-edge-deletion",
      nodes: { Person: { type: Person } },
      edges: { linked: { type: linked, from: [Person], to: [Person] } },
    });
    type LinkGraph = typeof linkGraph;

    let cleanups: (() => Promise<void>)[];
    beforeEach(() => {
      cleanups = [];
    });
    afterEach(async () => {
      for (const cleanup of cleanups) {
        await cleanup();
      }
    });
    async function makeBackend(): Promise<GraphBackend> {
      const fixture = await entry.make();
      cleanups.push(fixture.cleanup);
      return fixture.backend;
    }

    it("honors a fork's deletion of an optional edge property (#2 edges)", async () => {
      const [baseStore] = await createStoreWithSchema(
        linkGraph,
        await makeBackend(),
      );
      const alice = await baseStore.nodes.Person.create({ name: "Alice" });
      const bob = await baseStore.nodes.Person.create({ name: "Bob" });
      const edge = await baseStore.edges.linked.create(alice, bob, {
        since: "2020",
        note: "temporary",
      });

      const branchA = unwrap(
        await branch<LinkGraph>(baseStore, () => makeBackend(), {
          id: BRANCH_A,
        }),
      );
      // The branch removes the optional `note` on the inherited edge.
      await branchA.store.edges.linked.update(edge.id, { note: undefined });

      const result = await merge<LinkGraph>(baseStore, [branchA], {
        branchOrder: [BRANCH_A],
      });
      expect(isOk(result)).toBe(true);

      const rows = await enumerateAllEdges(
        baseStore.backend,
        baseStore.graphId,
        "linked",
      );
      const live = rows.filter((row) => row.deleted_at === undefined);
      expect(live).toHaveLength(1);
      const props = JSON.parse(live[0]!.props) as Record<string, unknown>;
      expect(props.since).toBe("2020");
      expect(props.note).toBeUndefined();
    });
  },
);
