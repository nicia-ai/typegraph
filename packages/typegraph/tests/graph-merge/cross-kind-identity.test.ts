/**
 * End-to-end regression for the `(kind, id)` identity re-key (design §6.4 / §7 T10).
 *
 * Node identity is the PAIR `(kind, id)`, and ids are caller-supplied, so two nodes of
 * DIFFERENT kinds may share an id string. The pre-re-key clustering keyed on the bare
 * id, silently FUSING such nodes into one cluster — a wrong merge that dropped a node,
 * mixed cross-kind props, and bypassed the §6.4-A base guard. These tests pin the
 * fixed behaviour from the public `merge()` surface:
 *
 *   1. unrelated kinds sharing an id (`Patient:x` / `Encounter:x`) NEVER fuse;
 *   2. under `reconcileTypes: "ontology"`, subtype-compatible kinds sharing an id
 *      (`Doctor:x` / `SpecialistDoctor:x`) ARE a cross-kind merge candidate — the same
 *      entity at a refined type — and collapse to the most-specific kind (the ontology
 *      retype is a candidate-EDGE rule, not an identity rule);
 *   3. with `reconcileTypes: "off"`, that same pair stays two distinct nodes — strict
 *      `(kind, id)` identity wins.
 */

import type { GraphBackend } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  subClassOf,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import { merge } from "../../src/graph-merge/merge";
import { isOk, unwrap } from "../../src/graph-merge/result";
import type {
  GraphBranch,
  MergeOptions,
  ReconcileTypesMode,
} from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { backendMatrix } from "./test-utils";

const Patient = defineNode("Patient", {
  schema: z.object({ name: z.string() }),
});
const Encounter = defineNode("Encounter", {
  schema: z.object({ reason: z.string() }),
});
const Doctor = defineNode("Doctor", {
  schema: z.object({ name: z.string() }),
});
const SpecialistDoctor = defineNode("SpecialistDoctor", {
  schema: z.object({ name: z.string() }),
});

// SpecialistDoctor ⊑ Doctor; Patient and Encounter are disjoint from each other.
const careGraph = defineGraph({
  id: "cross-kind-identity",
  nodes: {
    Patient: { type: Patient },
    Encounter: { type: Encounter },
    Doctor: { type: Doctor },
    SpecialistDoctor: { type: SpecialistDoctor },
  },
  edges: {},
  ontology: [subClassOf(SpecialistDoctor, Doctor)],
});
type CareGraph = typeof careGraph;

const BRANCH_A = asBranchId("provider-a");
const BRANCH_B = asBranchId("provider-b");

function mergeOptions(
  reconcileTypes: ReconcileTypesMode,
): MergeOptions<CareGraph> {
  return {
    resolve: {},
    reconcileTypes,
    onPropertyConflict: "flag",
    branchOrder: [BRANCH_A, BRANCH_B],
  };
}

describe.each(backendMatrix())("cross-kind identity merge [$name]", (entry) => {
  let cleanups: (() => Promise<void>)[];

  afterEach(async () => {
    for (const cleanup of cleanups ?? []) {
      await cleanup();
    }
    cleanups = [];
  });

  async function makeBackend(): Promise<GraphBackend> {
    const fixture = await entry.make();
    cleanups.push(fixture.cleanup);
    return fixture.backend;
  }

  async function forkedBranches(): Promise<
    Readonly<{
      base: Awaited<ReturnType<typeof createStoreWithSchema<CareGraph>>>[0];
      branches: readonly GraphBranch<CareGraph>[];
    }>
  > {
    const [base] = await createStoreWithSchema(careGraph, await makeBackend());
    const branchA = unwrap(
      await branch<CareGraph>(base, () => makeBackend(), { id: BRANCH_A }),
    );
    const branchB = unwrap(
      await branch<CareGraph>(base, () => makeBackend(), { id: BRANCH_B }),
    );
    return { base, branches: [branchA, branchB] };
  }

  it("does NOT fuse a Patient and an Encounter that share an id string", async () => {
    cleanups = [];
    const { base, branches } = await forkedBranches();
    const [branchA, branchB] = branches;

    // Same id "shared", UNRELATED kinds, staged on different branches.
    await branchA!.store.nodes.Patient.bulkCreate([
      { id: "shared", props: { name: "Anna Rivera" } },
    ]);
    await branchB!.store.nodes.Encounter.bulkCreate([
      { id: "shared", props: { reason: "annual checkup" } },
    ]);

    // Even with ontology ON, disjoint kinds are not retype-compatible → no fusion.
    const result = await merge<CareGraph>(
      base,
      branches,
      mergeOptions("ontology"),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      return;
    }

    // Two DISTINCT nodes survive, each with its own props intact.
    const patients = await base.nodes.Patient.find();
    const encounters = await base.nodes.Encounter.find();
    expect(patients).toHaveLength(1);
    expect(`${patients[0]?.id}`).toBe("shared");
    expect(patients[0]?.name).toBe("Anna Rivera");
    expect(encounters).toHaveLength(1);
    expect(`${encounters[0]?.id}`).toBe("shared");
    expect(encounters[0]?.reason).toBe("annual checkup");

    // No cross-kind id-merge, no spurious cross-kind property conflict, no reconcile.
    expect(result.data.resolutions).toEqual([]);
    expect(result.data.conflicts).toEqual([]);
    expect(result.data.typeReconciliations).toEqual([]);
  });

  it('reconciles a same-id Doctor / SpecialistDoctor pair under reconcileTypes:"ontology"', async () => {
    cleanups = [];
    const { base, branches } = await forkedBranches();
    const [branchA, branchB] = branches;

    // Same id "doc-1", SUBTYPE-compatible kinds — the same entity at a refined type.
    await branchA!.store.nodes.Doctor.bulkCreate([
      { id: "doc-1", props: { name: "Helen Park" } },
    ]);
    await branchB!.store.nodes.SpecialistDoctor.bulkCreate([
      { id: "doc-1", props: { name: "Helen Park" } },
    ]);

    const result = await merge<CareGraph>(
      base,
      branches,
      mergeOptions("ontology"),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      return;
    }

    // Collapsed to the MOST-SPECIFIC kind: one SpecialistDoctor, no leftover Doctor.
    const doctors = await base.nodes.Doctor.find();
    const specialists = await base.nodes.SpecialistDoctor.find();
    expect(doctors).toHaveLength(0);
    expect(specialists).toHaveLength(1);
    expect(`${specialists[0]?.id}`).toBe("doc-1");
    expect(specialists[0]?.name).toBe("Helen Park");

    // Reported as a type reconciliation (Doctor → SpecialistDoctor), keyed on the id.
    expect(result.data.typeReconciliations).toHaveLength(1);
    const reconciliation = result.data.typeReconciliations[0]!;
    expect(reconciliation.entityId).toBe("doc-1");
    expect(reconciliation.toType).toBe("SpecialistDoctor");
    expect([...reconciliation.fromTypes].sort()).toEqual([
      "Doctor",
      "SpecialistDoctor",
    ]);
  });

  it('keeps a same-id Doctor / SpecialistDoctor pair distinct under reconcileTypes:"off"', async () => {
    cleanups = [];
    const { base, branches } = await forkedBranches();
    const [branchA, branchB] = branches;

    await branchA!.store.nodes.Doctor.bulkCreate([
      { id: "doc-1", props: { name: "Helen Park" } },
    ]);
    await branchB!.store.nodes.SpecialistDoctor.bulkCreate([
      { id: "doc-1", props: { name: "Helen Park" } },
    ]);

    // "off": the ontology retype source emits nothing — strict (kind, id) identity.
    const result = await merge<CareGraph>(base, branches, mergeOptions("off"));
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      return;
    }

    const doctors = await base.nodes.Doctor.find();
    const specialists = await base.nodes.SpecialistDoctor.find();
    expect(doctors).toHaveLength(1);
    expect(specialists).toHaveLength(1);
    expect(result.data.typeReconciliations).toEqual([]);
    expect(result.data.resolutions).toEqual([]);
  });
});
