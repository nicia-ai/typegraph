import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  equivalentTo,
  generateId,
  subClassOf,
} from "@nicia-ai/typegraph";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { SubClassClosure } from "../../src/graph-merge/closures";
import { buildSubClassClosure } from "../../src/graph-merge/closures";
import type { MergeKey } from "../../src/graph-merge/node-key";
import type { ReconcileClusterInput } from "../../src/graph-merge/type-reconcile";
import {
  INCOMPATIBLE_TYPES_FLAG_REASON,
  reconcileTypes,
} from "../../src/graph-merge/type-reconcile";
import { createSqliteMergeBackend } from "./test-utils";

/**
 * Brands a plain string as a canonical identity key for the pure reconciliation
 * tests. The bare reports (`entityId`, dropped `id`) project this back via `idOf`,
 * which on a single-token (NUL-free) key returns the token unchanged — so these
 * assertions read identically to the bare-id form.
 */
function nodeId(value: string): MergeKey {
  return value as MergeKey;
}

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Doctor = defineNode("Doctor", {
  schema: z.object({ name: z.string() }),
});
const SpecialistDoctor = defineNode("SpecialistDoctor", {
  schema: z.object({ name: z.string() }),
});
const Physician = defineNode("Physician", {
  schema: z.object({ name: z.string() }),
});
const Animal = defineNode("Animal", {
  schema: z.object({ name: z.string() }),
});

/**
 * A taxonomy with a two-level subclass chain plus disjoint and equivalent types:
 *
 *   SpecialistDoctor ⊑ Doctor ⊑ Person
 *   Physician ≡ Doctor
 *   Animal     (disjoint from the Person tree)
 */
const taxonomyGraph = defineGraph({
  id: "type-reconcile-taxonomy",
  nodes: {
    Person: { type: Person },
    Doctor: { type: Doctor },
    SpecialistDoctor: { type: SpecialistDoctor },
    Physician: { type: Physician },
    Animal: { type: Animal },
  },
  edges: {},
  ontology: [
    subClassOf(SpecialistDoctor, Doctor),
    subClassOf(Doctor, Person),
    equivalentTo(Physician, Doctor),
  ],
});

describe("reconcileTypes over the public-closure glue (T10)", () => {
  let closure: SubClassClosure;

  beforeEach(async () => {
    const fixture = createSqliteMergeBackend();
    try {
      const [store] = await createStoreWithSchema(
        taxonomyGraph,
        fixture.backend,
      );
      closure = buildSubClassClosure(store.introspect().ontology);
    } finally {
      await fixture.cleanup();
    }
  });

  describe('mode "off" is a guaranteed no-op', () => {
    it("returns zero reconciliations even for a multi-kind cluster", () => {
      const clusters: readonly ReconcileClusterInput[] = [
        {
          canonicalId: nodeId("n1"),
          memberKinds: ["Doctor", "SpecialistDoctor"],
        },
      ];
      const result = reconcileTypes(clusters, closure, "off");
      expect(result.reconciliations).toEqual([]);
      expect(result.dropped).toEqual([]);
      expect(result.retypeMap.size).toBe(0);
    });
  });

  describe("subsumption collapse to the most-specific type", () => {
    it("collapses {Doctor, SpecialistDoctor} to SpecialistDoctor with a recorded reconciliation", () => {
      const canonicalId = nodeId("patient-1");
      const clusters: readonly ReconcileClusterInput[] = [
        { canonicalId, memberKinds: ["Doctor", "SpecialistDoctor"] },
      ];
      const result = reconcileTypes(clusters, closure, "ontology");

      expect(result.reconciliations).toHaveLength(1);
      const reconciliation = result.reconciliations[0]!;
      expect(reconciliation.entityId).toBe(canonicalId);
      expect(reconciliation.toType).toBe("SpecialistDoctor");
      expect([...reconciliation.fromTypes].sort()).toEqual([
        "Doctor",
        "SpecialistDoctor",
      ]);
      expect(result.retypeMap.get(canonicalId)).toBe("SpecialistDoctor");
      expect(result.dropped).toEqual([]);
    });

    it("collapses a full three-kind chain to the deepest descendant", () => {
      const canonicalId = nodeId("patient-2");
      const clusters: readonly ReconcileClusterInput[] = [
        {
          canonicalId,
          memberKinds: ["Person", "Doctor", "SpecialistDoctor"],
        },
      ];
      const result = reconcileTypes(clusters, closure, "ontology");

      expect(result.reconciliations).toHaveLength(1);
      expect(result.reconciliations[0]!.toType).toBe("SpecialistDoctor");
      expect(result.retypeMap.get(canonicalId)).toBe("SpecialistDoctor");
      expect(result.dropped).toEqual([]);
    });

    it("is independent of memberKinds ordering", () => {
      const canonicalId = nodeId("patient-3");
      const forward = reconcileTypes(
        [
          {
            canonicalId,
            memberKinds: ["Doctor", "SpecialistDoctor", "Person"],
          },
        ],
        closure,
        "ontology",
      );
      const reversed = reconcileTypes(
        [
          {
            canonicalId,
            memberKinds: ["Person", "SpecialistDoctor", "Doctor"],
          },
        ],
        closure,
        "ontology",
      );
      expect(forward.reconciliations[0]!.toType).toBe(
        reversed.reconciliations[0]!.toType,
      );
      expect(forward.reconciliations[0]!.toType).toBe("SpecialistDoctor");
    });
  });

  describe("equivalentTo handling", () => {
    it("collapses an equivalent pair to a single deterministic representative", () => {
      const canonicalId = nodeId("patient-4");
      const result = reconcileTypes(
        [{ canonicalId, memberKinds: ["Physician", "Doctor"] }],
        closure,
        "ontology",
      );

      expect(result.dropped).toEqual([]);
      expect(result.reconciliations).toHaveLength(1);
      // Physician ≡ Doctor: either qualifies as the minimum, so the
      // lexicographically-smallest representative ("Doctor") is chosen
      // deterministically — never flagged as incompatible.
      expect(result.reconciliations[0]!.toType).toBe("Doctor");
      expect(result.retypeMap.get(canonicalId)).toBe("Doctor");
    });

    it("collapses a subclass mixed with an equivalent parent to the subclass", () => {
      const canonicalId = nodeId("patient-5");
      // SpecialistDoctor ⊑ Doctor ≡ Physician, so SpecialistDoctor is below both.
      const result = reconcileTypes(
        [{ canonicalId, memberKinds: ["SpecialistDoctor", "Physician"] }],
        closure,
        "ontology",
      );
      expect(result.dropped).toEqual([]);
      expect(result.reconciliations[0]!.toType).toBe("SpecialistDoctor");
      expect(result.retypeMap.get(canonicalId)).toBe("SpecialistDoctor");
    });
  });

  describe("incompatible kinds are flagged, not collapsed", () => {
    it("flags a disjoint pair (Animal, Person) without collapsing", () => {
      const canonicalId = nodeId("mixed-1");
      const result = reconcileTypes(
        [{ canonicalId, memberKinds: ["Animal", "Person"] }],
        closure,
        "ontology",
      );

      expect(result.reconciliations).toEqual([]);
      expect(result.retypeMap.size).toBe(0);
      expect(result.dropped).toEqual([
        {
          kind: "node",
          id: canonicalId,
          reason: INCOMPATIBLE_TYPES_FLAG_REASON,
        },
      ]);
    });

    it("flags two siblings under a shared parent without collapsing", () => {
      // SpecialistDoctor and Animal share no common descendant; neither is
      // reachable from the other, so there is no single most-specific kind.
      const canonicalId = nodeId("mixed-2");
      const result = reconcileTypes(
        [{ canonicalId, memberKinds: ["SpecialistDoctor", "Animal"] }],
        closure,
        "ontology",
      );
      expect(result.reconciliations).toEqual([]);
      expect(result.dropped[0]!.reason).toBe(INCOMPATIBLE_TYPES_FLAG_REASON);
    });
  });

  describe("single-kind and mixed cluster sets", () => {
    it("ignores single-kind clusters entirely", () => {
      const result = reconcileTypes(
        [
          { canonicalId: nodeId("a"), memberKinds: ["Doctor"] },
          { canonicalId: nodeId("b"), memberKinds: ["Doctor", "Doctor"] },
        ],
        closure,
        "ontology",
      );
      expect(result.reconciliations).toEqual([]);
      expect(result.dropped).toEqual([]);
      expect(result.retypeMap.size).toBe(0);
    });

    it("partitions a batch into reconciled and flagged clusters, sorted by canonical id", () => {
      const compatible = nodeId("zzz-compatible");
      const incompatible = nodeId("aaa-incompatible");
      const result = reconcileTypes(
        [
          {
            canonicalId: compatible,
            memberKinds: ["Doctor", "SpecialistDoctor"],
          },
          { canonicalId: incompatible, memberKinds: ["Animal", "Person"] },
        ],
        closure,
        "ontology",
      );

      expect(result.reconciliations).toHaveLength(1);
      expect(result.reconciliations[0]!.entityId).toBe(compatible);
      expect(result.reconciliations[0]!.toType).toBe("SpecialistDoctor");

      expect(result.dropped).toHaveLength(1);
      expect(result.dropped[0]!.id).toBe(incompatible);
      expect(result.retypeMap.get(compatible)).toBe("SpecialistDoctor");
      expect(result.retypeMap.has(incompatible)).toBe(false);
    });

    it("produces a retype map keyed by canonical id usable by the T11 cascade", () => {
      const canonicalId = generateId() as MergeKey;
      const result = reconcileTypes(
        [{ canonicalId, memberKinds: ["Person", "SpecialistDoctor"] }],
        closure,
        "ontology",
      );
      expect(result.retypeMap.get(canonicalId)).toBe("SpecialistDoctor");
    });
  });
});
