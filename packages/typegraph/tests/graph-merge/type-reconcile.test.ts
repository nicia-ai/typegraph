import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  equivalentTo,
  type NodeType,
  type OntologyRelation,
  sameAs,
  subClassOf,
} from "@nicia-ai/typegraph";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { MergeKey } from "../../src/graph-merge/node-key";
import type { ReconcileClusterInput } from "../../src/graph-merge/type-reconcile";
import {
  INCOMPATIBLE_TYPES_FLAG_REASON,
  mostSpecificCommonKind,
  reconcileTypes,
} from "../../src/graph-merge/type-reconcile";
import type { KindRegistry } from "../../src/registry/kind-registry";
import { requireDefined } from "../../src/utils/presence";
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

/**
 * Builds a real store from `graph` and returns its validated `KindRegistry` —
 * the SAME registry a query runs on, so a reconciliation test and a query test
 * can never silently drift onto two different notions of "same class".
 */
async function registryFromGraph(
  graph: Parameters<typeof createStoreWithSchema>[0],
): Promise<KindRegistry> {
  const fixture = createSqliteMergeBackend();
  try {
    const [store] = await createStoreWithSchema(graph, fixture.backend);
    return store.registry;
  } finally {
    await fixture.cleanup();
  }
}

describe("reconcileTypes over the store's KindRegistry (T10)", () => {
  let registry: KindRegistry;

  beforeEach(async () => {
    const fixture = createSqliteMergeBackend();
    try {
      const [store] = await createStoreWithSchema(
        taxonomyGraph,
        fixture.backend,
      );
      registry = store.registry;
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
      const result = reconcileTypes(clusters, registry, "off");
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
      const result = reconcileTypes(clusters, registry, "ontology");

      expect(result.reconciliations).toHaveLength(1);
      const reconciliation = requireDefined(result.reconciliations[0]);
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
      const result = reconcileTypes(clusters, registry, "ontology");

      expect(result.reconciliations).toHaveLength(1);
      expect(requireDefined(result.reconciliations[0]).toType).toBe(
        "SpecialistDoctor",
      );
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
        registry,
        "ontology",
      );
      const reversed = reconcileTypes(
        [
          {
            canonicalId,
            memberKinds: ["Person", "SpecialistDoctor", "Doctor"],
          },
        ],
        registry,
        "ontology",
      );
      expect(requireDefined(forward.reconciliations[0]).toType).toBe(
        requireDefined(reversed.reconciliations[0]).toType,
      );
      expect(requireDefined(forward.reconciliations[0]).toType).toBe(
        "SpecialistDoctor",
      );
    });
  });

  describe("equivalentTo handling", () => {
    it("collapses an equivalent pair to a single deterministic representative", () => {
      const canonicalId = nodeId("patient-4");
      const result = reconcileTypes(
        [{ canonicalId, memberKinds: ["Physician", "Doctor"] }],
        registry,
        "ontology",
      );

      expect(result.dropped).toEqual([]);
      expect(result.reconciliations).toHaveLength(1);
      // Physician ≡ Doctor: either qualifies as the minimum, so the
      // code-point-smallest representative ("Doctor") is chosen
      // deterministically — never flagged as incompatible.
      expect(requireDefined(result.reconciliations[0]).toType).toBe("Doctor");
      expect(result.retypeMap.get(canonicalId)).toBe("Doctor");
    });

    it("collapses a subclass mixed with an equivalent parent to the subclass", () => {
      const canonicalId = nodeId("patient-5");
      // SpecialistDoctor ⊑ Doctor ≡ Physician, so SpecialistDoctor is below both.
      const result = reconcileTypes(
        [{ canonicalId, memberKinds: ["SpecialistDoctor", "Physician"] }],
        registry,
        "ontology",
      );
      expect(result.dropped).toEqual([]);
      expect(requireDefined(result.reconciliations[0]).toType).toBe(
        "SpecialistDoctor",
      );
      expect(result.retypeMap.get(canonicalId)).toBe("SpecialistDoctor");
    });

    it("collapses a bare equivalence pair with no subClassOf at all", async () => {
      // Regression for the pre-fold private closure, which could only express
      // equivalence found through an INTROSPECTED subClassOf chain. The
      // registry fold makes equivalentTo mutual subsumption directly, with no
      // subClassOf relation anywhere in the graph.
      const Client = defineNode("Client", { schema: z.object({}) });
      const Customer = defineNode("Customer", { schema: z.object({}) });
      const bareEquivalenceGraph = defineGraph({
        id: "type-reconcile-bare-equivalence",
        nodes: { Client: { type: Client }, Customer: { type: Customer } },
        edges: {},
        ontology: [equivalentTo(Client, Customer)],
      });
      const bareRegistry = await registryFromGraph(bareEquivalenceGraph);

      const canonicalId = nodeId("bare-1");
      const result = reconcileTypes(
        [{ canonicalId, memberKinds: ["Customer", "Client"] }],
        bareRegistry,
        "ontology",
      );

      expect(result.dropped).toEqual([]);
      expect(result.reconciliations).toHaveLength(1);
      // Both qualify as the minimum; "Client" is the code-point-smallest.
      expect(requireDefined(result.reconciliations[0]).toType).toBe("Client");
      expect(result.retypeMap.get(canonicalId)).toBe("Client");
    });
  });

  describe("incompatible kinds are flagged, not collapsed", () => {
    it("flags a disjoint pair (Animal, Person) without collapsing", () => {
      const canonicalId = nodeId("mixed-1");
      const result = reconcileTypes(
        [{ canonicalId, memberKinds: ["Animal", "Person"] }],
        registry,
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
        registry,
        "ontology",
      );
      expect(result.reconciliations).toEqual([]);
      expect(requireDefined(result.dropped[0]).reason).toBe(
        INCOMPATIBLE_TYPES_FLAG_REASON,
      );
    });
  });

  describe("single-kind and mixed cluster sets", () => {
    it("ignores single-kind clusters entirely", () => {
      const result = reconcileTypes(
        [
          { canonicalId: nodeId("a"), memberKinds: ["Doctor"] },
          { canonicalId: nodeId("b"), memberKinds: ["Doctor", "Doctor"] },
        ],
        registry,
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
        registry,
        "ontology",
      );

      expect(result.reconciliations).toHaveLength(1);
      expect(requireDefined(result.reconciliations[0]).entityId).toBe(
        compatible,
      );
      expect(requireDefined(result.reconciliations[0]).toType).toBe(
        "SpecialistDoctor",
      );

      expect(result.dropped).toHaveLength(1);
      expect(requireDefined(result.dropped[0]).id).toBe(incompatible);
      expect(result.retypeMap.get(compatible)).toBe("SpecialistDoctor");
      expect(result.retypeMap.has(incompatible)).toBe(false);
    });
  });
});

describe("mostSpecificCommonKind and reconcileTypes port cases (formerly graph-merge/closures.test.ts)", () => {
  const closuresTaxonomyGraph = defineGraph({
    id: "type-reconcile-closures-port-taxonomy",
    nodes: {
      Person: { type: Person },
      Doctor: { type: Doctor },
      SpecialistDoctor: { type: SpecialistDoctor },
      Animal: { type: Animal },
    },
    edges: {},
    ontology: [
      subClassOf(SpecialistDoctor, Doctor),
      subClassOf(Doctor, Person),
    ],
  });

  it("is reachable transitively (SpecialistDoctor -> Person)", async () => {
    const registry = await registryFromGraph(closuresTaxonomyGraph);
    expect(registry.isAssignableTo("SpecialistDoctor", "Doctor")).toBe(true);
    expect(registry.isAssignableTo("Doctor", "Person")).toBe(true);
    expect(registry.isAssignableTo("SpecialistDoctor", "Person")).toBe(true);
  });

  it("is not reachable in the reverse (superclass -> subclass) direction", async () => {
    const registry = await registryFromGraph(closuresTaxonomyGraph);
    expect(registry.isSubClassOf("Person", "SpecialistDoctor")).toBe(false);
    expect(registry.isSubClassOf("Person", "Doctor")).toBe(false);
    expect(registry.isSubClassOf("Doctor", "SpecialistDoctor")).toBe(false);
  });

  it("treats the subclass relation as strict (irreflexive)", async () => {
    const registry = await registryFromGraph(closuresTaxonomyGraph);
    expect(registry.isSubClassOf("Doctor", "Doctor")).toBe(false);
    expect(registry.isSubClassOf("SpecialistDoctor", "SpecialistDoctor")).toBe(
      false,
    );
  });

  it("reports unrelated types as mutually unassignable", async () => {
    const graph = defineGraph({
      id: "type-reconcile-closures-port-disjoint",
      nodes: {
        Person: { type: Person },
        Doctor: { type: Doctor },
        Animal: { type: Animal },
      },
      edges: {},
      ontology: [subClassOf(Doctor, Person)],
    });
    const registry = await registryFromGraph(graph);
    expect(registry.isAssignableTo("Animal", "Person")).toBe(false);
    expect(registry.isAssignableTo("Person", "Animal")).toBe(false);
    expect(registry.isAssignableTo("Doctor", "Animal")).toBe(false);
    expect(registry.isAssignableTo("Animal", "Doctor")).toBe(false);
  });

  it("returns false for types absent from the ontology, true for reflexive self-assignment", async () => {
    const registry = await registryFromGraph(closuresTaxonomyGraph);
    expect(registry.isAssignableTo("Nurse", "Person")).toBe(false);
    expect(registry.isAssignableTo("Person", "Nurse")).toBe(false);
    expect(registry.isAssignableTo("Nurse", "Nurse")).toBe(true);
  });

  describe("equivalentTo folding", () => {
    const equivalenceGraph = defineGraph({
      id: "type-reconcile-closures-port-equivalence",
      nodes: {
        Person: { type: Person },
        Doctor: { type: Doctor },
        Physician: { type: Physician },
        SpecialistDoctor: { type: SpecialistDoctor },
      },
      edges: {},
      ontology: [
        subClassOf(SpecialistDoctor, Doctor),
        subClassOf(Doctor, Person),
        equivalentTo(Physician, Doctor),
      ],
    });

    it("makes equivalent types mutually assignable", async () => {
      const registry = await registryFromGraph(equivalenceGraph);
      expect(registry.isAssignableTo("Physician", "Doctor")).toBe(true);
      expect(registry.isAssignableTo("Doctor", "Physician")).toBe(true);
    });

    it("shares ancestors and descendants across an equivalence class", async () => {
      const registry = await registryFromGraph(equivalenceGraph);
      // Physician ≡ Doctor, and Doctor ⊑ Person, so Physician ⊑ Person too.
      expect(registry.isAssignableTo("Physician", "Person")).toBe(true);
      // SpecialistDoctor ⊑ Doctor ≡ Physician, so SpecialistDoctor ⊑ Physician.
      expect(registry.isAssignableTo("SpecialistDoctor", "Physician")).toBe(
        true,
      );
    });
  });

  describe("sameAs folding", () => {
    /**
     * `sameAs` is the deprecated alias of `equivalentTo`. The registry fold
     * (`collectOntologyRelations`) folds both meta-edges into the same
     * `equivalent` bucket, so a closure recognizing only `equivalentTo` would
     * silently give these two graphs — identical up to that one keyword —
     * different type-reconciliation outcomes.
     */
    function equivalenceGraphUsing(
      // The shared, NodeType-only shape both `equivalentTo` and `sameAs`
      // satisfy — `typeof equivalentTo` itself is too wide to accept `sameAs`
      // here now that `equivalentTo`'s left parameter is widened to
      // `NodeType | AnyEdgeType` (D1's `sameAs` stays unwidened by design).
      relation: (
        kindA: NodeType,
        kindBOrIri: NodeType | string,
      ) => OntologyRelation,
      id: string,
    ): ReturnType<typeof defineGraph> {
      return defineGraph({
        id,
        nodes: {
          Person: { type: Person },
          Doctor: { type: Doctor },
          Physician: { type: Physician },
          SpecialistDoctor: { type: SpecialistDoctor },
        },
        edges: {},
        ontology: [
          subClassOf(SpecialistDoctor, Doctor),
          subClassOf(Doctor, Person),
          relation(Physician, Doctor),
        ],
      });
    }

    it("makes sameAs types mutually assignable", async () => {
      const registry = await registryFromGraph(
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- pins the migration-period alias behavior
        equivalenceGraphUsing(sameAs, "type-reconcile-closures-port-same-as"),
      );
      expect(registry.isAssignableTo("Physician", "Doctor")).toBe(true);
      expect(registry.isAssignableTo("Doctor", "Physician")).toBe(true);
      expect(registry.isAssignableTo("Physician", "Person")).toBe(true);
      expect(registry.isAssignableTo("SpecialistDoctor", "Physician")).toBe(
        true,
      );
    });

    it("reconciles a sameAs ontology exactly like an equivalentTo one", async () => {
      const normalize = (
        closureRegistry: KindRegistry,
      ): Readonly<{
        subClassAncestors: Record<string, string[]>;
        subClassDescendants: Record<string, string[]>;
        equivalenceSets: Record<string, string[]>;
      }> => ({
        subClassAncestors: Object.fromEntries(
          [...closureRegistry.subClassAncestors].map(([kind, ancestors]) => [
            kind,
            [...ancestors].sort(),
          ]),
        ),
        subClassDescendants: Object.fromEntries(
          [...closureRegistry.subClassDescendants].map(
            ([kind, descendants]) => [kind, [...descendants].sort()],
          ),
        ),
        equivalenceSets: Object.fromEntries(
          [...closureRegistry.equivalenceSets].map(([kind, members]) => [
            kind,
            [...members].sort(),
          ]),
        ),
      });

      const viaSameAs = await registryFromGraph(
        equivalenceGraphUsing(
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- pins the migration-period alias behavior
          sameAs,
          "type-reconcile-closures-port-same-as-parity",
        ),
      );
      const viaEquivalentTo = await registryFromGraph(
        equivalenceGraphUsing(
          equivalentTo,
          "type-reconcile-closures-port-equivalent-to-parity",
        ),
      );
      expect(normalize(viaSameAs)).toEqual(normalize(viaEquivalentTo));
    });
  });

  it("mostSpecificCommonKind: the deterministic tie-break is code-point order", async () => {
    const registry = await registryFromGraph(closuresTaxonomyGraph);
    expect(
      mostSpecificCommonKind(registry, ["Doctor", "SpecialistDoctor"]),
    ).toBe("SpecialistDoctor");
    expect(mostSpecificCommonKind(registry, ["Animal", "Person"])).toBe(
      undefined,
    );
  });

  it("mostSpecificCommonKind: a genuine tie is broken by code-point order regardless of input order", async () => {
    // `equivalentTo` makes both kinds mutually qualify as the minimum — a
    // REAL tie, unlike the single-qualifier case above — so this is the case
    // that actually exercises the tie-break sort rather than the filter.
    const equivalenceGraph = defineGraph({
      id: "type-reconcile-tie-break-order-independence",
      nodes: { Doctor: { type: Doctor }, Physician: { type: Physician } },
      edges: {},
      ontology: [equivalentTo(Physician, Doctor)],
    });
    const registry = await registryFromGraph(equivalenceGraph);
    expect(mostSpecificCommonKind(registry, ["Doctor", "Physician"])).toBe(
      "Doctor",
    );
    expect(mostSpecificCommonKind(registry, ["Physician", "Doctor"])).toBe(
      "Doctor",
    );
  });
});
