/**
 * Step 2 spike: the commit path, in isolation, when a cluster's canonical survivor
 * is an ALREADY-COMMITTED base node (design §6.2 — the riskiest core mutation,
 * pulled ahead of `baseUnique`).
 *
 * Proves, against a HAND-BUILT {@link MergePlan} (no clustering / candidate-gen
 * yet), that a canonical entity whose id is an existing committed node:
 *
 *   - UPDATES that committed row in place — not a duplicate insert (the committed
 *     identity is stable, so external references survive);
 *   - has the merged edges repointed onto it land on the surviving row;
 *   - absorbs the non-canonical cluster member (it is never separately inserted).
 *
 * Runs on BOTH backends (the backend-parity invariant for new-vs-base semantics).
 */

import type {
  EdgeId,
  GraphBackend,
  NodeId,
  NodeType,
} from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { CanonicalEntity } from "../../src/graph-merge/canonicalize";
import type { MergedEdge } from "../../src/graph-merge/edge-repoint";
import type { MergePlan } from "../../src/graph-merge/merge";
import { commitPlan } from "../../src/graph-merge/merge";
import { backendMatrix } from "./test-utils";

const Patient = defineNode("Patient", {
  schema: z.object({ name: z.string(), mrn: z.string().optional() }),
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
  id: "commit-care",
  nodes: { Patient: { type: Patient }, Encounter: { type: Encounter } },
  edges: {
    hadEncounter: { type: hadEncounter, from: [Patient], to: [Encounter] },
  },
});
type CareGraph = typeof careGraph;

function nodeId(value: string): NodeId<NodeType> {
  return value as NodeId<NodeType>;
}
function edgeId(value: string): EdgeId {
  return value as EdgeId;
}

/** An empty plan; tests override only the slices they exercise. */
function emptyPlan(): MergePlan<CareGraph> {
  return {
    canonicalEntities: [],
    survivingModifications: [],
    nodeDeletions: new Map(),
    mergedEdges: [],
    retypeMap: new Map(),
    resolutions: [],
    propertyConflicts: [],
    deleteModifyConflicts: [],
    typeReconciliations: [],
    dropped: [],
    baseAmbiguities: [],
    provenanceRecords: [],
    warnings: [],
  };
}

describe.each(backendMatrix())(
  "commit update-not-insert onto a base id [$name]",
  (entry) => {
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

    it("updates the committed base row in place and repoints an edge onto it", async () => {
      cleanups = [];
      const [target] = await createStoreWithSchema(
        careGraph,
        await makeBackend(),
      );

      // The committed base graph: one Patient (base-1) and one Encounter (enc-1).
      await target.nodes.Patient.bulkCreate([
        { id: "base-1", props: { name: "Anna R.", mrn: "MRN-1" } },
      ]);
      await target.nodes.Encounter.bulkCreate([
        { id: "enc-1", props: { reason: "checkup" } },
      ]);

      // A merge resolved {base-1 (committed), new-2 (a branch duplicate)} to the
      // base id base-1, unioning the branch's fuller name + a new edge from new-2
      // repointed onto base-1.
      const canonical: CanonicalEntity = {
        canonicalId: nodeId("base-1"),
        kind: "Patient",
        props: { name: "Anna Rivera", mrn: "MRN-1" },
        resolution: {
          canonicalId: nodeId("base-1"),
          memberIds: [nodeId("base-1"), nodeId("new-2")],
          kind: "Patient",
          branchOrigins: [],
        },
        conflicts: [],
      };
      const edge: MergedEdge = {
        id: edgeId("edge-new"),
        kind: "hadEncounter",
        fromId: nodeId("base-1"),
        toId: nodeId("enc-1"),
        fromKind: "Patient",
        toKind: "Encounter",
        props: { on: "2026-06-04" },
        mergedIds: [edgeId("edge-from-new-2")],
      };

      const plan: MergePlan<CareGraph> = {
        ...emptyPlan(),
        canonicalEntities: [canonical],
        mergedEdges: [edge],
      };

      const merged = await commitPlan(target, plan);
      console.info(`[${entry.name}] merged counts:`, merged);

      // UPDATE-NOT-INSERT: still exactly one Patient — base-1 — with the unioned
      // name. new-2 was absorbed (never inserted as its own row).
      const patients = await target.nodes.Patient.find();
      console.info(
        `[${entry.name}] patients after commit:`,
        patients.map((p) => `${p.id}:${p.name}`),
      );
      // The committed identity is stable: the SAME base-1 id carries the updated
      // props (a fresh insert would have minted a new id and left two rows).
      expect(patients).toHaveLength(1);
      expect(`${patients[0]?.id}`).toBe("base-1");
      expect(patients[0]?.name).toBe("Anna Rivera");

      // The repointed edge landed on the surviving base row.
      const edges = await target.edges.hadEncounter.find();
      console.info(
        `[${entry.name}] edges after commit:`,
        edges.map((e) => `${e.id}:${e.fromId}->${e.toId}`),
      );
      const repointed = edges.find((e) => e.id === "edge-new");
      expect(repointed).toBeDefined();
      expect(`${repointed?.fromId}`).toBe("base-1");
      expect(`${repointed?.toId}`).toBe("enc-1");

      expect(merged.nodes).toBe(1);
      expect(merged.edges).toBe(1);
    });

    it("a second commit of the same base canonical is idempotent (no duplicate)", async () => {
      cleanups = [];
      const [target] = await createStoreWithSchema(
        careGraph,
        await makeBackend(),
      );
      await target.nodes.Patient.bulkCreate([
        { id: "base-1", props: { name: "Anna R.", mrn: "MRN-1" } },
      ]);

      const canonical: CanonicalEntity = {
        canonicalId: nodeId("base-1"),
        kind: "Patient",
        props: { name: "Anna Rivera", mrn: "MRN-1" },
        resolution: {
          canonicalId: nodeId("base-1"),
          memberIds: [nodeId("base-1")],
          kind: "Patient",
          branchOrigins: [],
        },
        conflicts: [],
      };
      const plan: MergePlan<CareGraph> = {
        ...emptyPlan(),
        canonicalEntities: [canonical],
      };

      await commitPlan(target, plan);
      await commitPlan(target, plan);

      const patients = await target.nodes.Patient.find();
      expect(patients).toHaveLength(1);
      expect(patients[0]?.name).toBe("Anna Rivera");
    });
  },
);
