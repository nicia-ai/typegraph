import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineNode } from "../../src/core/node";
import { equivalentTo } from "../../src/ontology/core-meta-edges";
import { type OntologyRelation } from "../../src/ontology/types";
import {
  computeClosuresFromOntology,
  KindRegistry,
} from "../../src/registry/kind-registry";

// ============================================================
// Helpers
// ============================================================

// Cache of node types for test efficiency
const nodeTypeCache = new Map<string, ReturnType<typeof defineNode>>();

function getNodeType(name: string) {
  let nodeType = nodeTypeCache.get(name);
  if (!nodeType) {
    nodeType = defineNode(name, { schema: z.object({}) });
    nodeTypeCache.set(name, nodeType);
  }
  return nodeType;
}

/**
 * Creates an equivalence relation.
 */
function equiv(a: string, b: string): OntologyRelation {
  return equivalentTo(getNodeType(a), getNodeType(b));
}

/**
 * Creates a KindRegistry from equivalence pairs.
 */
function createEquivRegistry(
  pairs: readonly (readonly [string, string])[],
): KindRegistry {
  const relations = pairs.map(([a, b]) => equiv(a, b));
  const closures = computeClosuresFromOntology(relations);
  return new KindRegistry(new Map(), new Map(), closures);
}

/**
 * Generates unique kind names.
 */
const kindNameArb = fc.constantFrom(
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "Person",
  "Human",
  "Individual",
  "Company",
  "Corporation",
  "Business",
  "Animal",
  "Creature",
  "Being",
);

/**
 * Generates a pair of distinct kind names.
 */
const distinctPairArb = fc
  .tuple(kindNameArb, kindNameArb)
  .filter(([a, b]) => a !== b);

// ============================================================
// Property Tests - Equivalence Relation Properties
// ============================================================

describe("Equivalence Sets - Relation Properties", () => {
  describe("symmetry", () => {
    it("areEquivalent(a, b) ↔ areEquivalent(b, a)", () => {
      fc.assert(
        fc.property(distinctPairArb, ([a, b]) => {
          const registry = createEquivRegistry([[a, b]]);

          expect(registry.areEquivalent(a, b)).toBe(
            registry.areEquivalent(b, a),
          );
        }),
        { numRuns: 50 },
      );
    });

    it("relation direction doesn't matter", () => {
      fc.assert(
        fc.property(distinctPairArb, ([a, b]) => {
          const registry1 = createEquivRegistry([[a, b]]);
          const registry2 = createEquivRegistry([[b, a]]);

          // Both orderings produce the same equivalence
          expect(registry1.areEquivalent(a, b)).toBe(true);
          expect(registry2.areEquivalent(a, b)).toBe(true);
        }),
        { numRuns: 30 },
      );
    });
  });

  describe("transitivity", () => {
    it("if a ≡ b and b ≡ c then a ≡ c", () => {
      const tripleArb = fc
        .tuple(kindNameArb, kindNameArb, kindNameArb)
        .filter(([a, b, c]) => a !== b && b !== c && a !== c);

      fc.assert(
        fc.property(tripleArb, ([a, b, c]) => {
          const registry = createEquivRegistry([
            [a, b],
            [b, c],
          ]);

          expect(registry.areEquivalent(a, b)).toBe(true);
          expect(registry.areEquivalent(b, c)).toBe(true);
          expect(registry.areEquivalent(a, c)).toBe(true);
        }),
        { numRuns: 30 },
      );
    });

    it("long chains are fully connected", () => {
      // Create chain: A ≡ B ≡ C ≡ D ≡ E
      const registry = createEquivRegistry([
        ["A", "B"],
        ["B", "C"],
        ["C", "D"],
        ["D", "E"],
      ]);

      // All pairs should be equivalent
      const elements = ["A", "B", "C", "D", "E"];
      for (const a of elements) {
        for (const b of elements) {
          if (a === b) continue;
          expect(registry.areEquivalent(a, b)).toBe(true);
        }
      }
    });

    it("transitivity works through multiple hops", () => {
      // A ≡ B, C ≡ D, B ≡ C → all should be equivalent
      const registry = createEquivRegistry([
        ["A", "B"],
        ["C", "D"],
        ["B", "C"],
      ]);

      expect(registry.areEquivalent("A", "D")).toBe(true);
      expect(registry.areEquivalent("A", "C")).toBe(true);
      expect(registry.areEquivalent("B", "D")).toBe(true);
    });
  });

  describe("irreflexivity of equivalence set", () => {
    it("getEquivalents excludes self", () => {
      fc.assert(
        fc.property(distinctPairArb, ([a, b]) => {
          const registry = createEquivRegistry([[a, b]]);

          const aEquivs = registry.getEquivalents(a);
          const bEquivs = registry.getEquivalents(b);

          expect(aEquivs).not.toContain(a);
          expect(bEquivs).not.toContain(b);
        }),
        { numRuns: 30 },
      );
    });
  });
});

// ============================================================
// Property Tests - Equivalence Class Properties
// ============================================================

describe("Equivalence Sets - Class Properties", () => {
  describe("class membership consistency", () => {
    it("all members of a class have the same equivalents (minus themselves)", () => {
      const registry = createEquivRegistry([
        ["A", "B"],
        ["B", "C"],
        ["C", "D"],
      ]);

      const members = ["A", "B", "C", "D"];

      for (const m1 of members) {
        for (const m2 of members) {
          if (m1 === m2) continue;
          // m1's equivalents should include m2
          expect(registry.getEquivalents(m1)).toContain(m2);
        }
      }
    });

    it("equivalence classes partition the set", () => {
      // Two separate classes: {A, B, C} and {D, E}
      const registry = createEquivRegistry([
        ["A", "B"],
        ["B", "C"],
        ["D", "E"],
      ]);

      // Within class 1
      expect(registry.areEquivalent("A", "B")).toBe(true);
      expect(registry.areEquivalent("A", "C")).toBe(true);
      expect(registry.areEquivalent("B", "C")).toBe(true);

      // Within class 2
      expect(registry.areEquivalent("D", "E")).toBe(true);

      // Between classes
      expect(registry.areEquivalent("A", "D")).toBe(false);
      expect(registry.areEquivalent("A", "E")).toBe(false);
      expect(registry.areEquivalent("B", "D")).toBe(false);
      expect(registry.areEquivalent("C", "E")).toBe(false);
    });

    it("class sizes are consistent", () => {
      // Class of 4: A ≡ B ≡ C ≡ D
      const registry = createEquivRegistry([
        ["A", "B"],
        ["B", "C"],
        ["C", "D"],
      ]);

      // Each member's equivalents should have 3 elements (class size - 1)
      for (const member of ["A", "B", "C", "D"]) {
        expect(registry.getEquivalents(member)).toHaveLength(3);
      }
    });
  });

  describe("multiple disconnected classes", () => {
    it("handles multiple separate equivalence classes", () => {
      const classCountArb = fc.integer({ min: 2, max: 4 });
      const classSizeArb = fc.integer({ min: 2, max: 3 });

      fc.assert(
        fc.property(classCountArb, classSizeArb, (numberClasses, classSize) => {
          const pairs: [string, string][] = [];

          // Create numClasses separate chains
          for (let c = 0; c < numberClasses; c++) {
            for (let index = 0; index < classSize - 1; index++) {
              pairs.push([`Class${c}_${index}`, `Class${c}_${index + 1}`]);
            }
          }

          const registry = createEquivRegistry(pairs);

          // Check within-class equivalence
          for (let c = 0; c < numberClasses; c++) {
            for (let index = 0; index < classSize; index++) {
              for (let index_ = 0; index_ < classSize; index_++) {
                if (index === index_) continue;
                expect(
                  registry.areEquivalent(
                    `Class${c}_${index}`,
                    `Class${c}_${index_}`,
                  ),
                ).toBe(true);
              }
            }
          }

          // Check between-class non-equivalence
          if (numberClasses < 2) return;
          expect(registry.areEquivalent("Class0_0", "Class1_0")).toBe(false);
        }),
        { numRuns: 20 },
      );
    });
  });
});

// ============================================================
// Property Tests - Union-Find Algorithm Properties
// ============================================================

describe("Equivalence Sets - Union-Find Properties", () => {
  describe("order independence", () => {
    it("relation order doesn't affect equivalence classes", () => {
      // Same relations, different order
      const pairs1: [string, string][] = [
        ["A", "B"],
        ["B", "C"],
        ["C", "D"],
      ];
      const pairs2: [string, string][] = [
        ["C", "D"],
        ["A", "B"],
        ["B", "C"],
      ];
      const pairs3: [string, string][] = [
        ["B", "C"],
        ["C", "D"],
        ["A", "B"],
      ];

      const registry1 = createEquivRegistry(pairs1);
      const registry2 = createEquivRegistry(pairs2);
      const registry3 = createEquivRegistry(pairs3);

      // All should produce same equivalences
      for (const a of ["A", "B", "C", "D"]) {
        for (const b of ["A", "B", "C", "D"]) {
          expect(registry1.areEquivalent(a, b)).toBe(
            registry2.areEquivalent(a, b),
          );
          expect(registry2.areEquivalent(a, b)).toBe(
            registry3.areEquivalent(a, b),
          );
        }
      }
    });

    it("randomly shuffled relations produce same result", () => {
      const pairsArb = fc
        .array(distinctPairArb, { minLength: 2, maxLength: 5 })
        .chain((pairs) =>
          fc.tuple(
            fc.constant(pairs),
            fc.shuffledSubarray(pairs, {
              minLength: pairs.length,
              maxLength: pairs.length,
            }),
          ),
        );

      fc.assert(
        fc.property(pairsArb, ([original, shuffled]) => {
          const registry1 = createEquivRegistry(original);
          const registry2 = createEquivRegistry(shuffled);

          // Collect all elements
          const elements = new Set<string>();
          for (const [a, b] of original) {
            elements.add(a);
            elements.add(b);
          }

          // Check all pairs produce same result
          for (const a of elements) {
            for (const b of elements) {
              expect(registry1.areEquivalent(a, b)).toBe(
                registry2.areEquivalent(a, b),
              );
            }
          }
        }),
        { numRuns: 30 },
      );
    });
  });

  describe("idempotence", () => {
    it("duplicate relations don't change result", () => {
      const pairs: [string, string][] = [
        ["A", "B"],
        ["B", "C"],
      ];
      const duplicated: [string, string][] = [
        ["A", "B"],
        ["A", "B"], // Duplicate
        ["B", "C"],
        ["B", "C"], // Duplicate
        ["A", "B"], // Triple
      ];

      const registry1 = createEquivRegistry(pairs);
      const registry2 = createEquivRegistry(duplicated);

      for (const a of ["A", "B", "C"]) {
        for (const b of ["A", "B", "C"]) {
          expect(registry1.areEquivalent(a, b)).toBe(
            registry2.areEquivalent(a, b),
          );
        }
      }
    });

    it("self-equivalence relations are no-ops", () => {
      const pairsWithSelf: [string, string][] = [
        ["A", "B"],
        ["A", "A"], // Self-relation
        ["B", "B"], // Self-relation
        ["B", "C"],
      ];
      const pairsWithoutSelf: [string, string][] = [
        ["A", "B"],
        ["B", "C"],
      ];

      const registry1 = createEquivRegistry(pairsWithSelf);
      const registry2 = createEquivRegistry(pairsWithoutSelf);

      for (const a of ["A", "B", "C"]) {
        for (const b of ["A", "B", "C"]) {
          expect(registry1.areEquivalent(a, b)).toBe(
            registry2.areEquivalent(a, b),
          );
        }
      }
    });
  });

  describe("class merging", () => {
    it("connecting two classes merges them", () => {
      // Initially: {A, B} and {C, D}
      // After connecting B-C: {A, B, C, D}
      const registry = createEquivRegistry([
        ["A", "B"],
        ["C", "D"],
        ["B", "C"], // Bridge
      ]);

      expect(registry.areEquivalent("A", "D")).toBe(true);
      expect(registry.getEquivalents("A")).toHaveLength(3);
    });

    it("multiple bridges don't create duplicates", () => {
      // Multiple connections between classes
      const registry = createEquivRegistry([
        ["A", "B"],
        ["C", "D"],
        ["B", "C"], // Bridge 1
        ["A", "D"], // Bridge 2 (redundant)
      ]);

      // Should still be one class of 4
      expect(registry.getEquivalents("A")).toHaveLength(3);
      expect(new Set(registry.getEquivalents("A"))).toEqual(
        new Set(["B", "C", "D"]),
      );
    });
  });
});

// ============================================================
// Property Tests - Edge Cases
// ============================================================

describe("Equivalence Sets - Edge Cases", () => {
  it("empty relations produce no equivalences", () => {
    const registry = createEquivRegistry([]);

    expect(registry.areEquivalent("A", "B")).toBe(false);
    expect(registry.getEquivalents("A")).toHaveLength(0);
  });

  it("single pair creates two-element class", () => {
    fc.assert(
      fc.property(distinctPairArb, ([a, b]) => {
        const registry = createEquivRegistry([[a, b]]);

        expect(registry.areEquivalent(a, b)).toBe(true);
        expect(registry.getEquivalents(a)).toEqual([b]);
        expect(registry.getEquivalents(b)).toEqual([a]);
      }),
      { numRuns: 30 },
    );
  });

  it("handles star topology (one central node)", () => {
    // A is equivalent to B, C, D, E (star pattern)
    const registry = createEquivRegistry([
      ["A", "B"],
      ["A", "C"],
      ["A", "D"],
      ["A", "E"],
    ]);

    // All should be equivalent
    const elements = ["A", "B", "C", "D", "E"];
    for (const x of elements) {
      for (const y of elements) {
        if (x === y) continue;
        expect(registry.areEquivalent(x, y)).toBe(true);
      }
    }

    // Each should have 4 equivalents
    for (const x of elements) {
      expect(registry.getEquivalents(x)).toHaveLength(4);
    }
  });

  it("handles cycle topology", () => {
    // A ≡ B, B ≡ C, C ≡ D, D ≡ A (cycle)
    const registry = createEquivRegistry([
      ["A", "B"],
      ["B", "C"],
      ["C", "D"],
      ["D", "A"],
    ]);

    // All should be equivalent
    const elements = ["A", "B", "C", "D"];
    for (const x of elements) {
      for (const y of elements) {
        if (x === y) continue;
        expect(registry.areEquivalent(x, y)).toBe(true);
      }
    }
  });

  it("handles complete graph topology", () => {
    // All pairs explicitly stated
    const registry = createEquivRegistry([
      ["A", "B"],
      ["A", "C"],
      ["A", "D"],
      ["B", "C"],
      ["B", "D"],
      ["C", "D"],
    ]);

    // All should be equivalent with 3 equivalents each
    for (const x of ["A", "B", "C", "D"]) {
      expect(registry.getEquivalents(x)).toHaveLength(3);
    }
  });

  it("unknown elements have no equivalents", () => {
    const registry = createEquivRegistry([["A", "B"]]);

    expect(registry.areEquivalent("X", "Y")).toBe(false);
    expect(registry.areEquivalent("A", "X")).toBe(false);
    expect(registry.getEquivalents("X")).toHaveLength(0);
  });
});

// ============================================================
// Property Tests - Algebraic Properties
// ============================================================

describe("Equivalence Sets - Algebraic Properties", () => {
  it("equivalence relation is an equivalence relation", () => {
    // Test the mathematical definition: reflexive (on set), symmetric, transitive
    const registry = createEquivRegistry([
      ["A", "B"],
      ["B", "C"],
      ["D", "E"],
    ]);

    const class1 = ["A", "B", "C"];
    const class2 = ["D", "E"];

    // Within each class: symmetric and transitive
    for (const cls of [class1, class2]) {
      for (const a of cls) {
        for (const b of cls) {
          if (a === b) continue;
          // Symmetric
          expect(registry.areEquivalent(a, b)).toBe(
            registry.areEquivalent(b, a),
          );
          // Both true (transitive closure)
          expect(registry.areEquivalent(a, b)).toBe(true);
        }
      }
    }

    // Between classes: both false
    for (const a of class1) {
      for (const b of class2) {
        expect(registry.areEquivalent(a, b)).toBe(false);
      }
    }
  });

  it("union is commutative", () => {
    fc.assert(
      fc.property(distinctPairArb, distinctPairArb, ([a, b], [c, d]) => {
        // Order of union operations shouldn't matter
        const registry1 = createEquivRegistry([
          [a, b],
          [c, d],
        ]);
        const registry2 = createEquivRegistry([
          [c, d],
          [a, b],
        ]);

        const elements = [a, b, c, d];
        for (const x of elements) {
          for (const y of elements) {
            expect(registry1.areEquivalent(x, y)).toBe(
              registry2.areEquivalent(x, y),
            );
          }
        }
      }),
      { numRuns: 30 },
    );
  });

  it("union is associative", () => {
    // ((A ≡ B) then (B ≡ C)) same as ((B ≡ C) then (A ≡ B))
    const registry1 = createEquivRegistry([
      ["A", "B"],
      ["B", "C"],
    ]);
    const registry2 = createEquivRegistry([
      ["B", "C"],
      ["A", "B"],
    ]);

    for (const a of ["A", "B", "C"]) {
      for (const b of ["A", "B", "C"]) {
        expect(registry1.areEquivalent(a, b)).toBe(
          registry2.areEquivalent(a, b),
        );
      }
    }
  });
});
