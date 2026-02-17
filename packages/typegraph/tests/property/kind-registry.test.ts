import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineNode } from "../../src/core/node";
import { type NodeType } from "../../src/core/types";
import {
  META_EDGE_BROADER,
  META_EDGE_DISJOINT_WITH,
  META_EDGE_EQUIVALENT_TO,
  META_EDGE_IMPLIES,
  META_EDGE_INVERSE_OF,
  META_EDGE_PART_OF,
  META_EDGE_SUB_CLASS_OF,
} from "../../src/ontology/constants";
import { core } from "../../src/ontology/core-meta-edges";
import { type MetaEdge, type OntologyRelation } from "../../src/ontology/types";
import {
  computeClosuresFromOntology,
  createEmptyClosures,
  KindRegistry,
} from "../../src/registry/kind-registry";

// ============================================================
// Helpers for Test Data Generation
// ============================================================

// Cache of node types for test efficiency
const nodeTypeCache = new Map<string, NodeType>();

function getNodeType(name: string): NodeType {
  let nodeType = nodeTypeCache.get(name);
  if (!nodeType) {
    nodeType = defineNode(name, {
      schema: z.object({ value: z.string().optional() }),
    });
    nodeTypeCache.set(name, nodeType);
  }
  return nodeType;
}

// Map from meta-edge name to the actual meta-edge object
const metaEdgeMap: Record<string, MetaEdge> = {
  [META_EDGE_SUB_CLASS_OF]: core.subClassOfMetaEdge,
  [META_EDGE_BROADER]: core.broaderMetaEdge,
  [META_EDGE_DISJOINT_WITH]: core.disjointWithMetaEdge,
  [META_EDGE_EQUIVALENT_TO]: core.equivalentToMetaEdge,
  [META_EDGE_PART_OF]: core.partOfMetaEdge,
  [META_EDGE_INVERSE_OF]: core.inverseOfMetaEdge,
  [META_EDGE_IMPLIES]: core.impliesMetaEdge,
};

/**
 * Creates an ontology relation.
 */
function createRelation(
  from: string,
  metaEdgeName: string,
  to: string,
): OntologyRelation {
  const metaEdge = metaEdgeMap[metaEdgeName];
  if (!metaEdge) {
    throw new Error(`Unknown meta-edge: ${metaEdgeName}`);
  }
  return {
    metaEdge,
    from: getNodeType(from),
    to: getNodeType(to),
  };
}

/**
 * Creates a KindRegistry from ontology relations.
 */
function createRegistry(relations: readonly OntologyRelation[]): KindRegistry {
  const closures = computeClosuresFromOntology(relations);
  return new KindRegistry(new Map(), new Map(), closures);
}

/**
 * Creates a KindRegistry with subClassOf relations.
 */
function createSubClassRegistry(
  pairs: readonly (readonly [string, string])[],
): KindRegistry {
  const relations = pairs.map(([child, parent]) =>
    createRelation(child, META_EDGE_SUB_CLASS_OF, parent),
  );
  return createRegistry(relations);
}

// ============================================================
// Property Tests - isSubClassOf / isAssignableTo
// ============================================================

describe("KindRegistry Subsumption Properties", () => {
  describe("isAssignableTo", () => {
    it("reflexivity: every kind is assignable to itself", () => {
      const kindArb = fc.constantFrom(
        "Person",
        "Organization",
        "Company",
        "University",
        "Animal",
        "Dog",
        "Cat",
      );

      fc.assert(
        fc.property(kindArb, (kind) => {
          const registry = createRegistry([]);
          expect(registry.isAssignableTo(kind, kind)).toBe(true);
        }),
        { numRuns: 20 },
      );
    });

    it("subsumption: child is assignable to parent", () => {
      const pairs: (readonly [string, string])[] = [
        ["Company", "Organization"],
        ["Dog", "Animal"],
        ["Employee", "Person"],
      ];

      fc.assert(
        fc.property(fc.constantFrom(...pairs), ([child, parent]) => {
          const registry = createSubClassRegistry([[child, parent]]);
          expect(registry.isAssignableTo(child, parent)).toBe(true);
        }),
        { numRuns: 10 },
      );
    });

    it("transitivity: if A < B and B < C, then A assignable to C", () => {
      // Build a chain: Dog < Animal < LivingThing
      const relations = [
        createRelation("Dog", META_EDGE_SUB_CLASS_OF, "Animal"),
        createRelation("Animal", META_EDGE_SUB_CLASS_OF, "LivingThing"),
      ];
      const registry = createRegistry(relations);

      expect(registry.isAssignableTo("Dog", "Animal")).toBe(true);
      expect(registry.isAssignableTo("Animal", "LivingThing")).toBe(true);
      expect(registry.isAssignableTo("Dog", "LivingThing")).toBe(true);
    });
  });

  describe("isSubClassOf", () => {
    it("irreflexivity: a kind is not a subclass of itself", () => {
      const kindArb = fc.constantFrom("Person", "Company", "Animal");

      fc.assert(
        fc.property(kindArb, (kind) => {
          const registry = createRegistry([]);
          // isSubClassOf should be strict (non-reflexive)
          expect(registry.isSubClassOf(kind, kind)).toBe(false);
        }),
        { numRuns: 10 },
      );
    });

    it("transitivity: if A subClassOf B and B subClassOf C, then A subClassOf C", () => {
      const chainArb = fc.tuple(
        fc.constantFrom("Cat", "Dog", "Eagle"),
        fc.constantFrom("Mammal", "Bird", "Animal"),
        fc.constantFrom("Creature", "Entity", "Thing"),
      );

      fc.assert(
        fc.property(chainArb, ([child, middle, parent]) => {
          // Skip if any are the same (would break chain)
          // Note: Cast to string for comparison since the literal types are disjoint
          if (
            (child as string) === middle ||
            (middle as string) === parent ||
            (child as string) === parent
          )
            return;

          const relations = [
            createRelation(child, META_EDGE_SUB_CLASS_OF, middle),
            createRelation(middle, META_EDGE_SUB_CLASS_OF, parent),
          ];
          const registry = createRegistry(relations);

          expect(registry.isSubClassOf(child, middle)).toBe(true);
          expect(registry.isSubClassOf(middle, parent)).toBe(true);
          expect(registry.isSubClassOf(child, parent)).toBe(true);
        }),
        { numRuns: 20 },
      );
    });
  });

  describe("expandSubClasses", () => {
    it("always includes the original kind", () => {
      const kindArb = fc.constantFrom("Person", "Company", "Animal");

      fc.assert(
        fc.property(kindArb, (kind) => {
          const registry = createRegistry([]);
          const expanded = registry.expandSubClasses(kind);
          expect(expanded).toContain(kind);
        }),
        { numRuns: 10 },
      );
    });

    it("includes all descendants", () => {
      const relations = [
        createRelation("Dog", META_EDGE_SUB_CLASS_OF, "Animal"),
        createRelation("Cat", META_EDGE_SUB_CLASS_OF, "Animal"),
        createRelation("Labrador", META_EDGE_SUB_CLASS_OF, "Dog"),
      ];
      const registry = createRegistry(relations);

      const expanded = registry.expandSubClasses("Animal");
      expect(expanded).toContain("Animal");
      expect(expanded).toContain("Dog");
      expect(expanded).toContain("Cat");
      expect(expanded).toContain("Labrador");
    });
  });

  describe("getAncestors / getDescendants consistency", () => {
    it("ancestors and descendants are inverse relations", () => {
      const relations = [
        createRelation("Dog", META_EDGE_SUB_CLASS_OF, "Animal"),
        createRelation("Animal", META_EDGE_SUB_CLASS_OF, "LivingThing"),
      ];
      const registry = createRegistry(relations);

      // Dog's ancestors include Animal and LivingThing
      const dogAncestors = registry.getAncestors("Dog");
      expect(dogAncestors.has("Animal")).toBe(true);
      expect(dogAncestors.has("LivingThing")).toBe(true);

      // LivingThing's descendants include Animal and Dog
      const livingDescendants = registry.getDescendants("LivingThing");
      expect(livingDescendants.has("Animal")).toBe(true);
      expect(livingDescendants.has("Dog")).toBe(true);

      // Animal is in Dog's ancestors iff Dog is in Animal's descendants
      expect(registry.getDescendants("Animal").has("Dog")).toBe(true);
    });
  });
});

// ============================================================
// Property Tests - Equivalence
// ============================================================

describe("KindRegistry Equivalence Properties", () => {
  describe("areEquivalent", () => {
    it("symmetry: areEquivalent(a, b) ↔ areEquivalent(b, a)", () => {
      const pairArb = fc.tuple(
        fc.constantFrom("Person", "Human", "Individual"),
        fc.constantFrom("Person", "Human", "Individual"),
      );

      fc.assert(
        fc.property(pairArb, ([a, b]) => {
          const relations = [
            createRelation("Person", META_EDGE_EQUIVALENT_TO, "Human"),
            createRelation("Human", META_EDGE_EQUIVALENT_TO, "Individual"),
          ];
          const registry = createRegistry(relations);

          expect(registry.areEquivalent(a, b)).toBe(
            registry.areEquivalent(b, a),
          );
        }),
        { numRuns: 20 },
      );
    });

    it("transitivity: if a ≡ b and b ≡ c, then a ≡ c", () => {
      const relations = [
        createRelation("Person", META_EDGE_EQUIVALENT_TO, "Human"),
        createRelation("Human", META_EDGE_EQUIVALENT_TO, "Individual"),
      ];
      const registry = createRegistry(relations);

      // Person ≡ Human (direct)
      expect(registry.areEquivalent("Person", "Human")).toBe(true);
      // Human ≡ Individual (direct)
      expect(registry.areEquivalent("Human", "Individual")).toBe(true);
      // Person ≡ Individual (transitive)
      expect(registry.areEquivalent("Person", "Individual")).toBe(true);
    });

    it("non-equivalent kinds return false", () => {
      const relations = [
        createRelation("Person", META_EDGE_EQUIVALENT_TO, "Human"),
      ];
      const registry = createRegistry(relations);

      expect(registry.areEquivalent("Person", "Animal")).toBe(false);
      expect(registry.areEquivalent("Dog", "Cat")).toBe(false);
    });
  });

  describe("getEquivalents", () => {
    it("excludes self from equivalence set", () => {
      const relations = [
        createRelation("Person", META_EDGE_EQUIVALENT_TO, "Human"),
      ];
      const registry = createRegistry(relations);

      const personEquivalents = registry.getEquivalents("Person");
      expect(personEquivalents).not.toContain("Person");
      expect(personEquivalents).toContain("Human");
    });

    it("includes all transitively equivalent kinds", () => {
      const relations = [
        createRelation("A", META_EDGE_EQUIVALENT_TO, "B"),
        createRelation("B", META_EDGE_EQUIVALENT_TO, "C"),
      ];
      const registry = createRegistry(relations);

      const aEquivalents = registry.getEquivalents("A");
      expect(aEquivalents).toContain("B");
      expect(aEquivalents).toContain("C");
    });
  });
});

// ============================================================
// Property Tests - Disjointness
// ============================================================

describe("KindRegistry Disjointness Properties", () => {
  describe("areDisjoint", () => {
    it("symmetry: areDisjoint(a, b) ↔ areDisjoint(b, a)", () => {
      const pairArb = fc.tuple(
        fc.constantFrom("Person", "Organization", "Animal"),
        fc.constantFrom("Person", "Organization", "Animal"),
      );

      fc.assert(
        fc.property(pairArb, ([a, b]) => {
          const relations = [
            createRelation("Person", META_EDGE_DISJOINT_WITH, "Organization"),
          ];
          const registry = createRegistry(relations);

          expect(registry.areDisjoint(a, b)).toBe(registry.areDisjoint(b, a));
        }),
        { numRuns: 20 },
      );
    });

    it("irreflexivity: nothing is disjoint with itself", () => {
      const kindArb = fc.constantFrom("Person", "Organization", "Animal");

      fc.assert(
        fc.property(kindArb, (kind) => {
          const relations = [
            createRelation("Person", META_EDGE_DISJOINT_WITH, "Organization"),
          ];
          const registry = createRegistry(relations);

          expect(registry.areDisjoint(kind, kind)).toBe(false);
        }),
        { numRuns: 10 },
      );
    });

    it("returns true for declared disjoint pairs", () => {
      const relations = [
        createRelation("Person", META_EDGE_DISJOINT_WITH, "Organization"),
        createRelation("Dog", META_EDGE_DISJOINT_WITH, "Cat"),
      ];
      const registry = createRegistry(relations);

      expect(registry.areDisjoint("Person", "Organization")).toBe(true);
      expect(registry.areDisjoint("Dog", "Cat")).toBe(true);
    });
  });

  describe("getDisjointKinds", () => {
    it("returns all kinds declared disjoint", () => {
      const relations = [
        createRelation("Person", META_EDGE_DISJOINT_WITH, "Organization"),
        createRelation("Person", META_EDGE_DISJOINT_WITH, "Animal"),
      ];
      const registry = createRegistry(relations);

      const disjointWithPerson = registry.getDisjointKinds("Person");
      expect(disjointWithPerson).toContain("Organization");
      expect(disjointWithPerson).toContain("Animal");
    });

    it("works in both directions", () => {
      const relations = [
        createRelation("Person", META_EDGE_DISJOINT_WITH, "Organization"),
      ];
      const registry = createRegistry(relations);

      expect(registry.getDisjointKinds("Person")).toContain("Organization");
      expect(registry.getDisjointKinds("Organization")).toContain("Person");
    });
  });
});

// ============================================================
// Property Tests - Broader/Narrower Hierarchy
// ============================================================

describe("KindRegistry Hierarchy Properties", () => {
  describe("isNarrowerThan / isBroaderThan", () => {
    it("inverse relationship: isNarrowerThan(a, b) ↔ isBroaderThan(b, a)", () => {
      const relations = [
        createRelation("Dog", META_EDGE_BROADER, "Animal"),
        createRelation("Labrador", META_EDGE_BROADER, "Dog"),
      ];
      const registry = createRegistry(relations);

      // Dog is narrower than Animal
      expect(registry.isNarrowerThan("Dog", "Animal")).toBe(true);
      // Animal is broader than Dog
      expect(registry.isBroaderThan("Animal", "Dog")).toBe(true);

      // Labrador is narrower than Dog
      expect(registry.isNarrowerThan("Labrador", "Dog")).toBe(true);
      // Dog is broader than Labrador
      expect(registry.isBroaderThan("Dog", "Labrador")).toBe(true);
    });

    it("transitivity: if A narrower B and B narrower C, then A narrower C", () => {
      const relations = [
        createRelation("Labrador", META_EDGE_BROADER, "Dog"),
        createRelation("Dog", META_EDGE_BROADER, "Animal"),
      ];
      const registry = createRegistry(relations);

      expect(registry.isNarrowerThan("Labrador", "Dog")).toBe(true);
      expect(registry.isNarrowerThan("Dog", "Animal")).toBe(true);
      expect(registry.isNarrowerThan("Labrador", "Animal")).toBe(true);
    });
  });

  describe("expandNarrower / expandBroader", () => {
    it("expandNarrower includes self and all narrower concepts", () => {
      const relations = [
        createRelation("Dog", META_EDGE_BROADER, "Animal"),
        createRelation("Cat", META_EDGE_BROADER, "Animal"),
      ];
      const registry = createRegistry(relations);

      const expanded = registry.expandNarrower("Animal");
      expect(expanded).toContain("Animal");
      expect(expanded).toContain("Dog");
      expect(expanded).toContain("Cat");
    });

    it("expandBroader includes self and all broader concepts", () => {
      const relations = [
        createRelation("Dog", META_EDGE_BROADER, "Animal"),
        createRelation("Animal", META_EDGE_BROADER, "LivingThing"),
      ];
      const registry = createRegistry(relations);

      const expanded = registry.expandBroader("Dog");
      expect(expanded).toContain("Dog");
      expect(expanded).toContain("Animal");
      expect(expanded).toContain("LivingThing");
    });
  });
});

// ============================================================
// Property Tests - Part-Whole Composition
// ============================================================

describe("KindRegistry Composition Properties", () => {
  describe("isPartOf", () => {
    it("transitivity: if A partOf B and B partOf C, then A partOf C", () => {
      const relations = [
        createRelation("Wheel", META_EDGE_PART_OF, "Car"),
        createRelation("Car", META_EDGE_PART_OF, "Fleet"),
      ];
      const registry = createRegistry(relations);

      expect(registry.isPartOf("Wheel", "Car")).toBe(true);
      expect(registry.isPartOf("Car", "Fleet")).toBe(true);
      expect(registry.isPartOf("Wheel", "Fleet")).toBe(true);
    });

    it("irreflexivity: nothing is part of itself", () => {
      const kindArb = fc.constantFrom("Wheel", "Car", "Engine");

      fc.assert(
        fc.property(kindArb, (kind) => {
          const registry = createRegistry([]);
          expect(registry.isPartOf(kind, kind)).toBe(false);
        }),
        { numRuns: 10 },
      );
    });
  });

  describe("getParts / getWholes consistency", () => {
    it("getParts and getWholes are inverse relations", () => {
      const relations = [
        createRelation("Wheel", META_EDGE_PART_OF, "Car"),
        createRelation("Engine", META_EDGE_PART_OF, "Car"),
      ];
      const registry = createRegistry(relations);

      // Car has parts: Wheel, Engine
      const carParts = registry.getParts("Car");
      expect(carParts).toContain("Wheel");
      expect(carParts).toContain("Engine");

      // Wheel is part of Car
      const wheelWholes = registry.getWholes("Wheel");
      expect(wheelWholes).toContain("Car");
    });
  });
});

// ============================================================
// Property Tests - Edge Inverses
// ============================================================

describe("KindRegistry Edge Inverse Properties", () => {
  describe("getInverseEdge", () => {
    it("involution: if inverse(A) = B, then inverse(B) = A", () => {
      const relations = [
        createRelation("worksFor", META_EDGE_INVERSE_OF, "employs"),
        createRelation("parentOf", META_EDGE_INVERSE_OF, "childOf"),
      ];
      const registry = createRegistry(relations);

      // worksFor ↔ employs
      expect(registry.getInverseEdge("worksFor")).toBe("employs");
      expect(registry.getInverseEdge("employs")).toBe("worksFor");

      // parentOf ↔ childOf
      expect(registry.getInverseEdge("parentOf")).toBe("childOf");
      expect(registry.getInverseEdge("childOf")).toBe("parentOf");
    });

    it("returns undefined for edges without inverse", () => {
      const registry = createRegistry([]);
      expect(registry.getInverseEdge("unknownEdge")).toBeUndefined();
    });
  });
});

// ============================================================
// Property Tests - Edge Implications
// ============================================================

describe("KindRegistry Edge Implication Properties", () => {
  describe("getImpliedEdges / getImplyingEdges", () => {
    it("are inverse relations", () => {
      const relations = [
        createRelation("owns", META_EDGE_IMPLIES, "controls"),
        createRelation("controls", META_EDGE_IMPLIES, "manages"),
      ];
      const registry = createRegistry(relations);

      // owns implies controls and manages (transitive)
      const ownsImplied = registry.getImpliedEdges("owns");
      expect(ownsImplied).toContain("controls");
      expect(ownsImplied).toContain("manages");

      // manages is implied by owns and controls
      const managedImplying = registry.getImplyingEdges("manages");
      expect(managedImplying).toContain("owns");
      expect(managedImplying).toContain("controls");
    });

    it("transitivity: if A implies B and B implies C, then A implies C", () => {
      const relations = [
        createRelation("owns", META_EDGE_IMPLIES, "possesses"),
        createRelation("possesses", META_EDGE_IMPLIES, "hasAccessTo"),
      ];
      const registry = createRegistry(relations);

      expect(registry.getImpliedEdges("owns")).toContain("possesses");
      expect(registry.getImpliedEdges("owns")).toContain("hasAccessTo");
    });
  });

  describe("expandImplyingEdges", () => {
    it("includes self and all implying edges", () => {
      const relations = [
        createRelation("owns", META_EDGE_IMPLIES, "controls"),
        createRelation("inherits", META_EDGE_IMPLIES, "controls"),
      ];
      const registry = createRegistry(relations);

      const expanded = registry.expandImplyingEdges("controls");
      expect(expanded).toContain("controls");
      expect(expanded).toContain("owns");
      expect(expanded).toContain("inherits");
    });
  });
});

// ============================================================
// Property Tests - Empty Registry
// ============================================================

describe("KindRegistry Empty State", () => {
  it("createEmptyClosures produces valid empty registry", () => {
    const closures = createEmptyClosures();
    const registry = new KindRegistry(new Map(), new Map(), closures);

    // Should not throw on any operation
    expect(registry.isSubClassOf("A", "B")).toBe(false);
    expect(registry.areEquivalent("A", "B")).toBe(false);
    expect(registry.areDisjoint("A", "B")).toBe(false);
    expect(registry.isPartOf("A", "B")).toBe(false);
    expect(registry.getInverseEdge("A")).toBeUndefined();
  });

  it("empty registry handles reflexive checks correctly", () => {
    const closures = createEmptyClosures();
    const registry = new KindRegistry(new Map(), new Map(), closures);

    const kindArb = fc.constantFrom("A", "B", "C", "Person", "Dog");

    fc.assert(
      fc.property(kindArb, (kind) => {
        // isAssignableTo is reflexive even for unknown kinds
        expect(registry.isAssignableTo(kind, kind)).toBe(true);
        // isSubClassOf is irreflexive
        expect(registry.isSubClassOf(kind, kind)).toBe(false);
        // Nothing is disjoint with itself
        expect(registry.areDisjoint(kind, kind)).toBe(false);
      }),
      { numRuns: 10 },
    );
  });
});

// ============================================================
// Property Tests - hasNodeType / hasEdgeType
// ============================================================

describe("KindRegistry Type Existence", () => {
  it("hasNodeType returns true only for registered types", () => {
    const nodeKinds = new Map([
      ["Person", getNodeType("Person")],
      ["Company", getNodeType("Company")],
    ]);
    const registry = new KindRegistry(
      nodeKinds,
      new Map(),
      createEmptyClosures(),
    );

    expect(registry.hasNodeType("Person")).toBe(true);
    expect(registry.hasNodeType("Company")).toBe(true);
    expect(registry.hasNodeType("Unknown")).toBe(false);
  });

  it("getNodeType returns type for registered, undefined for unregistered", () => {
    const nodeKinds = new Map([["Person", getNodeType("Person")]]);
    const registry = new KindRegistry(
      nodeKinds,
      new Map(),
      createEmptyClosures(),
    );

    expect(registry.getNodeType("Person")?.kind).toBe("Person");
    expect(registry.getNodeType("Unknown")).toBeUndefined();
  });
});

// ============================================================
// Property Tests - computeClosuresFromOntology
// ============================================================

describe("computeClosuresFromOntology Properties", () => {
  it("handles empty ontology", () => {
    const closures = computeClosuresFromOntology([]);

    expect(closures.subClassAncestors.size).toBe(0);
    expect(closures.equivalenceSets.size).toBe(0);
    expect(closures.disjointPairs.size).toBe(0);
  });

  it("handles mixed relation types", () => {
    const relations = [
      createRelation("Dog", META_EDGE_SUB_CLASS_OF, "Animal"),
      createRelation("Person", META_EDGE_EQUIVALENT_TO, "Human"),
      createRelation("Cat", META_EDGE_DISJOINT_WITH, "Dog"),
      createRelation("Wheel", META_EDGE_PART_OF, "Car"),
      createRelation("worksFor", META_EDGE_INVERSE_OF, "employs"),
      createRelation("owns", META_EDGE_IMPLIES, "controls"),
    ];
    const closures = computeClosuresFromOntology(relations);

    // Verify each closure type was populated
    expect(closures.subClassAncestors.get("Dog")?.has("Animal")).toBe(true);
    expect(closures.equivalenceSets.get("Person")?.has("Human")).toBe(true);
    expect(closures.disjointPairs.has("Cat|Dog")).toBe(true);
    expect(closures.partOfClosure.get("Wheel")?.has("Car")).toBe(true);
    expect(closures.edgeInverses.get("worksFor")).toBe("employs");
    expect(closures.edgeImplicationsClosure.get("owns")?.has("controls")).toBe(
      true,
    );
  });
});
