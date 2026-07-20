/**
 * On-graph provenance persistence — the sidecar provenance graph (open-item #5).
 *
 * With `persistProvenance: true`, the merge upserts one `{branch, sourceId}` row
 * per contribution into a sidecar graph on the SAME backend, queryable AFTER the
 * merge via `openProvenanceStore` / `readProvenance`. Asserted on BOTH backends:
 *
 *   1. the persisted rows match the in-memory `report.provenance.byBranch` index;
 *   2. a resolved canonical carries provenance from BOTH contributing branches
 *      (with the original fork-local `sourceId`s);
 *   3. edges are tagged too (`role: "edge"`);
 *   4. re-persisting is idempotent (deterministic ids → upsert, no duplicates);
 *   5. it is OFF by default (no `provenancePersisted`, no rows).
 */
import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import { merge } from "../../src/graph-merge/merge";
import {
  openProvenanceStore,
  persistProvenanceRecords,
  provenanceGraphId,
} from "../../src/graph-merge/provenance-store";
import { isOk, unwrap } from "../../src/graph-merge/result";
import type { GraphBranch, MergeOptions } from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { requireDefined } from "../../src/utils/presence";
import { backendMatrix } from "./test-utils";

const Patient = defineNode("Patient", {
  schema: z.object({ name: z.string(), birthDate: z.string() }),
});
const Encounter = defineNode("Encounter", {
  schema: z.object({ reason: z.string() }),
});
const hadEncounter = defineEdge("hadEncounter", {
  schema: z.object({ on: z.string() }),
  from: [Patient],
  to: [Encounter],
});

const careGraph = defineGraph({
  id: "provenance-test-care",
  nodes: { Patient: { type: Patient }, Encounter: { type: Encounter } },
  edges: {
    hadEncounter: { type: hadEncounter, from: [Patient], to: [Encounter] },
  },
});
type CareGraph = typeof careGraph;

const BRANCH_A = asBranchId("provider-a");
const BRANCH_B = asBranchId("provider-b");

/** Fulltext name match (no embedder): "Anna Rivera" ~ "Ana Rivera" clears 0.85. */
function provMergeOptions(persistProvenance: boolean): MergeOptions<CareGraph> {
  return {
    resolve: {
      Patient: {
        block: (node) => (node as unknown as { birthDate?: string }).birthDate,
        similarity: { kind: "fulltext", fields: ["name"] },
        threshold: 0.85,
      },
    },
    onPropertyConflict: "flag",
    branchOrder: [BRANCH_A, BRANCH_B],
    persistProvenance,
  };
}

type Fixture = Readonly<{
  backend: GraphBackend;
  base: Store<CareGraph>;
  branches: readonly GraphBranch<CareGraph>[];
}>;

describe.each(backendMatrix())("provenance persistence [$name]", (entry) => {
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

  /**
   * Base + two branches: each adds a near-duplicate Patient (same birthDate) plus
   * its own Encounter joined by a hadEncounter edge. The merge resolves the two
   * Patients into one canonical and repoints both edges onto it.
   */
  async function materialize(): Promise<Fixture> {
    const backend = await makeBackend();
    const [base] = await createStoreWithSchema(careGraph, backend);
    const branchA = unwrap(
      await branch<CareGraph>(base, () => makeBackend(), { id: BRANCH_A }),
    );
    const branchB = unwrap(
      await branch<CareGraph>(base, () => makeBackend(), { id: BRANCH_B }),
    );

    await branchA.store.nodes.Patient.bulkCreate([
      {
        id: "pat-anna",
        props: { name: "Anna Rivera", birthDate: "1974-03-09" },
      },
    ]);
    await branchA.store.nodes.Encounter.bulkCreate([
      { id: "enc-a", props: { reason: "checkup" } },
    ]);
    await branchA.store.edges.hadEncounter.bulkCreate([
      {
        id: "edge-a",
        from: { kind: "Patient", id: "pat-anna" },
        to: { kind: "Encounter", id: "enc-a" },
        props: { on: "1974-03-09" },
      },
    ]);

    await branchB.store.nodes.Patient.bulkCreate([
      { id: "pat-ana", props: { name: "Ana Rivera", birthDate: "1974-03-09" } },
    ]);
    await branchB.store.nodes.Encounter.bulkCreate([
      { id: "enc-b", props: { reason: "referral" } },
    ]);
    await branchB.store.edges.hadEncounter.bulkCreate([
      {
        id: "edge-b",
        from: { kind: "Patient", id: "pat-ana" },
        to: { kind: "Encounter", id: "enc-b" },
        props: { on: "1974-03-09" },
      },
    ]);

    return { backend, base, branches: [branchA, branchB] };
  }

  it("opens from a backend and graph id without the target GraphDef", async () => {
    cleanups = [];
    const { backend, base, branches } = await materialize();
    unwrap(await merge<CareGraph>(base, branches, provMergeOptions(true)));

    const provStore = await openProvenanceStore(backend, base.graphId);
    expect(await provStore.nodes.Provenance.find()).not.toHaveLength(0);
  });

  it("persists {branch, sourceId} rows that match the report index", async () => {
    cleanups = [];
    const { base, branches } = await materialize();

    const result = await merge<CareGraph>(
      base,
      branches,
      provMergeOptions(true),
    );
    expect(isOk(result)).toBe(true);
    const report = unwrap(result);

    // The report announces the sidecar graph + the row count.
    expect(report.provenancePersisted?.graphId).toBe(
      provenanceGraphId(base.graphId),
    );
    expect(report.provenancePersisted?.count).toBeGreaterThan(0);
    expect(report.warnings).toEqual([]);

    const provStore = await openProvenanceStore(base);

    // Every node id the in-memory index credits to a branch is persisted for it.
    for (const branchId of [BRANCH_A, BRANCH_B]) {
      const reported = report.provenance.byBranch(branchId);
      const persisted = await provStore.nodes.Provenance.find();
      const persistedNodeIds = new Set(
        persisted
          .filter((p) => p.branchId === branchId && p.role === "node")
          .map((p) => p.canonicalId),
      );
      for (const nodeId of reported.nodeIds) {
        expect(persistedNodeIds.has(nodeId)).toBe(true);
      }
    }
  });

  it("tags the resolved canonical with BOTH branches and keeps each source id", async () => {
    cleanups = [];
    const { base, branches } = await materialize();
    unwrap(await merge<CareGraph>(base, branches, provMergeOptions(true)));

    const patients = await base.nodes.Patient.find();
    expect(patients).toHaveLength(1);
    const canonicalId = requireDefined(patients[0]).id;

    const provStore = await openProvenanceStore(base);
    const forCanonical = (await provStore.nodes.Provenance.find()).filter(
      (p) => p.canonicalId === canonicalId,
    );

    // Two contributions — one per branch — each keeping the fork-local source id.
    expect(new Set(forCanonical.map((p) => p.branchId))).toEqual(
      new Set([BRANCH_A, BRANCH_B]),
    );
    expect(new Set(forCanonical.map((p) => p.sourceId))).toEqual(
      new Set(["pat-anna", "pat-ana"]),
    );

    // Edges are tagged too.
    const edges = (await provStore.nodes.Provenance.find()).filter(
      (p) => p.role === "edge",
    );
    expect(edges.length).toBeGreaterThanOrEqual(2);
  });

  it("is idempotent: re-persisting the same records upserts (no duplicates)", async () => {
    cleanups = [];
    const { base, branches } = await materialize();
    unwrap(await merge<CareGraph>(base, branches, provMergeOptions(true)));

    const provStore = await openProvenanceStore(base);
    const firstCount = (await provStore.nodes.Provenance.find()).length;

    // Re-persist the SAME records (as a re-run would): deterministic ids → upsert.
    const records = (await provStore.nodes.Provenance.find()).map((p) => ({
      role: p.role,
      canonicalId: p.canonicalId,
      canonicalKind: p.canonicalKind,
      branchId: asBranchId(p.branchId),
      sourceId: p.sourceId,
    }));
    await persistProvenanceRecords(provStore, base.graphId, records);

    const secondCount = (await provStore.nodes.Provenance.find()).length;
    expect(secondCount).toBe(firstCount);
  });

  it("is OFF by default: no provenancePersisted, no rows", async () => {
    cleanups = [];
    const { base, branches } = await materialize();

    const report = unwrap(
      await merge<CareGraph>(base, branches, provMergeOptions(false)),
    );
    expect(report.provenancePersisted).toBeUndefined();

    const provStore = await openProvenanceStore(base);
    expect(await provStore.nodes.Provenance.find()).toHaveLength(0);
  });
});
