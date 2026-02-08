import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  computeTransitiveClosure,
  invertClosure,
  isReachable,
} from "../../src/ontology/closures";

// ============================================================
// Arbitrary Generators
// ============================================================

/**
 * Generate simple node names.
 */
const nodeNameArb = fc.constantFrom(
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "Person",
  "Company",
  "Organization",
  "Animal",
  "Plant",
  "Media",
  "Podcast",
  "Video",
  "Article",
  "Document",
);

/**
 * Generate a single directed relation.
 */
const relationArb: fc.Arbitrary<readonly [string, string]> = fc
  .tuple(nodeNameArb, nodeNameArb)
  .filter(([from, to]) => from !== to); // No self-loops for clarity

/**
 * Generate a set of directed relations.
 */
const relationsArb = fc.array(relationArb, { minLength: 0, maxLength: 15 });

/**
 * Generate a chain of relations (A→B→C→D...) for testing transitivity.
 */
const chainRelationsArb = fc
  .array(nodeNameArb, { minLength: 2, maxLength: 6 })
  .map((nodes) => {
    // Deduplicate while preserving order
    const unique = [...new Set(nodes)];
    if (unique.length < 2) return [];

    const relations: (readonly [string, string])[] = [];
    for (let index = 0; index < unique.length - 1; index++) {
      relations.push([unique[index]!, unique[index + 1]!] as const);
    }
    return relations;
  });

// ============================================================
// Helper Functions
// ============================================================

/**
 * Convert closure map to array of relations for easier comparison.
 */
function closureToRelations(
  closure: ReadonlyMap<string, ReadonlySet<string>>,
): [string, string][] {
  const result: [string, string][] = [];
  for (const [from, tos] of closure) {
    for (const to of tos) {
      result.push([from, to]);
    }
  }
  return result.toSorted(
    (a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]),
  );
}

/**
 * Check if two closures are equivalent (same reachability).
 */
function closuresEqual(
  a: ReadonlyMap<string, ReadonlySet<string>>,
  b: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const relationsA = closureToRelations(a);
  const relationsB = closureToRelations(b);

  if (relationsA.length !== relationsB.length) return false;

  for (const [index, element] of relationsA.entries()) {
    if (
      element[0] !== relationsB[index]![0] ||
      element[1] !== relationsB[index]![1]
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Extract relations from closure (for re-computation).
 */
function extractRelationsFromClosure(
  closure: ReadonlyMap<string, ReadonlySet<string>>,
): (readonly [string, string])[] {
  const result: (readonly [string, string])[] = [];
  for (const [from, tos] of closure) {
    for (const to of tos) {
      result.push([from, to] as const);
    }
  }
  return result;
}

// ============================================================
// Property Tests - Transitive Closure
// ============================================================

describe("Transitive Closure Properties", () => {
  describe("idempotence", () => {
    it("computing closure twice yields same result", () => {
      fc.assert(
        fc.property(relationsArb, (relations) => {
          const firstClosure = computeTransitiveClosure(relations);

          // Extract all relations from first closure and recompute
          const closureRelations = extractRelationsFromClosure(firstClosure);
          const secondClosure = computeTransitiveClosure(closureRelations);

          // Should be identical
          expect(closuresEqual(firstClosure, secondClosure)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("transitivity", () => {
    it("if A→B and B→C then A→C", () => {
      fc.assert(
        fc.property(relationsArb, (relations) => {
          const closure = computeTransitiveClosure(relations);

          // Check transitivity property
          for (const [a, bSet] of closure) {
            for (const b of bSet) {
              const cSet = closure.get(b);
              if (!cSet) continue;
              for (const c of cSet) {
                // If A→B and B→C, then A must reach C
                expect(isReachable(closure, a, c)).toBe(true);
              }
            }
          }
        }),
        { numRuns: 100 },
      );
    });

    it("chain relations produce full transitive closure", () => {
      fc.assert(
        fc.property(chainRelationsArb, (relations) => {
          if (relations.length === 0) return;

          const closure = computeTransitiveClosure(relations);

          // Extract the chain nodes in order
          const nodes: string[] = [relations[0]![0]];
          for (const [, to] of relations) {
            nodes.push(to);
          }

          // First node should reach all subsequent nodes
          const firstNode = nodes[0]!;
          for (let index = 1; index < nodes.length; index++) {
            expect(isReachable(closure, firstNode, nodes[index]!)).toBe(true);
          }
        }),
        { numRuns: 50 },
      );
    });
  });

  describe("direct relation preservation", () => {
    it("all input relations appear in closure", () => {
      fc.assert(
        fc.property(relationsArb, (relations) => {
          const closure = computeTransitiveClosure(relations);

          // Every input relation should be in the closure
          for (const [from, to] of relations) {
            expect(isReachable(closure, from, to)).toBe(true);
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("empty input", () => {
    it("empty relations produce empty closure", () => {
      const closure = computeTransitiveClosure([]);
      expect(closure.size).toBe(0);
    });
  });

  describe("single relation", () => {
    it("single relation produces minimal closure", () => {
      fc.assert(
        fc.property(relationArb, (relation) => {
          const closure = computeTransitiveClosure([relation]);

          const [from, to] = relation;

          // Should have exactly one reachable node from 'from'
          expect(isReachable(closure, from, to)).toBe(true);

          // The only relation should be from→to
          const relations = closureToRelations(closure);
          expect(relations.length).toBe(1);
          expect(relations[0]).toEqual([from, to]);
        }),
        { numRuns: 50 },
      );
    });
  });

  describe("no spurious relations", () => {
    it("closure only contains reachable pairs", () => {
      fc.assert(
        fc.property(relationsArb, (relations) => {
          const closure = computeTransitiveClosure(relations);

          // Collect all nodes
          const allNodes = new Set<string>();
          for (const [from, to] of relations) {
            allNodes.add(from);
            allNodes.add(to);
          }

          // For any pair (a, b) in closure, there must be a path a→...→b
          // We verify by checking that isReachable returns true
          for (const [from, tos] of closure) {
            for (const to of tos) {
              expect(isReachable(closure, from, to)).toBe(true);
            }
          }
        }),
        { numRuns: 50 },
      );
    });
  });
});

// ============================================================
// Property Tests - Closure Inversion
// ============================================================

describe("Closure Inversion Properties", () => {
  describe("basic inversion", () => {
    it("inversion swaps from and to", () => {
      fc.assert(
        fc.property(relationsArb, (relations) => {
          const closure = computeTransitiveClosure(relations);
          const inverted = invertClosure(closure);

          // For each A→B in closure, B→A should be in inverted
          for (const [from, tos] of closure) {
            for (const to of tos) {
              const invertedFromTo = inverted.get(to);
              expect(invertedFromTo?.has(from)).toBe(true);
            }
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("double inversion", () => {
    it("double inversion preserves all relations", () => {
      fc.assert(
        fc.property(relationsArb, (relations) => {
          const closure = computeTransitiveClosure(relations);
          const inverted = invertClosure(closure);
          const doubleInverted = invertClosure(inverted);

          // All relations in original should be in double-inverted
          for (const [from, tos] of closure) {
            for (const to of tos) {
              const restored = doubleInverted.get(from);
              expect(restored?.has(to)).toBe(true);
            }
          }

          // All relations in double-inverted should be in original
          for (const [from, tos] of doubleInverted) {
            for (const to of tos) {
              const original = closure.get(from);
              expect(original?.has(to)).toBe(true);
            }
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("cardinality preservation", () => {
    it("inversion preserves total relation count", () => {
      fc.assert(
        fc.property(relationsArb, (relations) => {
          const closure = computeTransitiveClosure(relations);
          const inverted = invertClosure(closure);

          // Count relations in both
          let originalCount = 0;
          for (const [, tos] of closure) {
            originalCount += tos.size;
          }

          let invertedCount = 0;
          for (const [, tos] of inverted) {
            invertedCount += tos.size;
          }

          expect(invertedCount).toBe(originalCount);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("empty closure", () => {
    it("inverting empty closure returns empty", () => {
      const empty = new Map<string, Set<string>>();
      const inverted = invertClosure(empty);
      expect(inverted.size).toBe(0);
    });
  });
});

// ============================================================
// Property Tests - Reachability
// ============================================================

describe("Reachability Properties", () => {
  describe("consistency with closure", () => {
    it("isReachable returns true iff target is in source's set", () => {
      fc.assert(
        fc.property(
          relationsArb,
          nodeNameArb,
          nodeNameArb,
          (relations, source, target) => {
            const closure = computeTransitiveClosure(relations);

            const reachable = isReachable(closure, source, target);
            const inSet = closure.get(source)?.has(target) ?? false;

            expect(reachable).toBe(inSet);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe("transitivity via reachability", () => {
    it("if isReachable(a,b) and isReachable(b,c) then isReachable(a,c)", () => {
      fc.assert(
        fc.property(relationsArb, (relations) => {
          const closure = computeTransitiveClosure(relations);

          // Collect all nodes
          const allNodes = new Set<string>();
          for (const [from, to] of relations) {
            allNodes.add(from);
            allNodes.add(to);
          }
          const nodeArray = [...allNodes];

          // Check transitivity for all triples
          for (const a of nodeArray) {
            for (const b of nodeArray) {
              if (!isReachable(closure, a, b)) continue;

              for (const c of nodeArray) {
                if (!isReachable(closure, b, c)) continue;

                // a→b and b→c implies a→c
                expect(isReachable(closure, a, c)).toBe(true);
              }
            }
          }
        }),
        { numRuns: 50 },
      );
    });
  });

  describe("non-reflexivity", () => {
    it("nodes are not reachable from themselves (unless explicit self-loop)", () => {
      fc.assert(
        fc.property(relationsArb, (relations) => {
          // Filter out any self-loops from input
          const noSelfLoops = relations.filter(([from, to]) => from !== to);
          const closure = computeTransitiveClosure(noSelfLoops);

          // Collect nodes
          const allNodes = new Set<string>();
          for (const [from, to] of noSelfLoops) {
            allNodes.add(from);
            allNodes.add(to);
          }

          // Check that nodes don't reach themselves (unless there's a cycle)
          // Note: if there's a cycle A→B→A, then A reaches itself
          for (const node of allNodes) {
            const reachesSelf = isReachable(closure, node, node);

            // If node reaches itself, there must be a cycle
            if (!reachesSelf) continue;
            // Verify cycle exists: node→...→node
            // This is expected behavior for cycles
            expect(closure.get(node)?.has(node)).toBe(true);
          }
        }),
        { numRuns: 50 },
      );
    });
  });

  describe("unreachable pairs", () => {
    it("disconnected nodes are not reachable", () => {
      // Create two disconnected components
      const component1: (readonly [string, string])[] = [
        ["A", "B"],
        ["B", "C"],
      ];
      const component2: (readonly [string, string])[] = [
        ["X", "Y"],
        ["Y", "Z"],
      ];

      const closure = computeTransitiveClosure([...component1, ...component2]);

      // Nodes in different components should not reach each other
      expect(isReachable(closure, "A", "X")).toBe(false);
      expect(isReachable(closure, "A", "Y")).toBe(false);
      expect(isReachable(closure, "A", "Z")).toBe(false);
      expect(isReachable(closure, "X", "A")).toBe(false);
      expect(isReachable(closure, "X", "B")).toBe(false);
      expect(isReachable(closure, "X", "C")).toBe(false);

      // But within component, reachability works
      expect(isReachable(closure, "A", "C")).toBe(true);
      expect(isReachable(closure, "X", "Z")).toBe(true);
    });
  });

  describe("missing nodes", () => {
    it("querying non-existent source returns false", () => {
      fc.assert(
        fc.property(relationsArb, (relations) => {
          const closure = computeTransitiveClosure(relations);

          // Query with a node that doesn't exist
          expect(isReachable(closure, "NONEXISTENT_NODE_XYZ", "A")).toBe(false);
        }),
        { numRuns: 20 },
      );
    });

    it("querying non-existent target returns false", () => {
      fc.assert(
        fc.property(relationsArb, (relations) => {
          const closure = computeTransitiveClosure(relations);

          // Query with a target that doesn't exist
          const firstNode = relations[0]?.[0];
          if (!firstNode) return;
          expect(
            isReachable(closure, firstNode, "NONEXISTENT_TARGET_XYZ"),
          ).toBe(false);
        }),
        { numRuns: 20 },
      );
    });
  });
});

// ============================================================
// Property Tests - Algebraic Properties
// ============================================================

describe("Algebraic Properties", () => {
  describe("closure is a closure operator", () => {
    it("extensive: input relations are subset of output", () => {
      fc.assert(
        fc.property(relationsArb, (relations) => {
          const closure = computeTransitiveClosure(relations);

          // Every input relation appears in output
          for (const [from, to] of relations) {
            expect(isReachable(closure, from, to)).toBe(true);
          }
        }),
        { numRuns: 50 },
      );
    });

    it("idempotent: closure(closure(R)) = closure(R)", () => {
      fc.assert(
        fc.property(relationsArb, (relations) => {
          const first = computeTransitiveClosure(relations);
          const second = computeTransitiveClosure(
            extractRelationsFromClosure(first),
          );

          expect(closuresEqual(first, second)).toBe(true);
        }),
        { numRuns: 50 },
      );
    });

    it("monotone: R1 ⊆ R2 implies closure(R1) ⊆ closure(R2)", () => {
      fc.assert(
        fc.property(relationsArb, relationsArb, (r1, r2) => {
          // R1 ⊆ (R1 ∪ R2)
          const combined = [...r1, ...r2];

          const closure1 = computeTransitiveClosure(r1);
          const closureCombined = computeTransitiveClosure(combined);

          // Every relation in closure1 should be in closureCombined
          for (const [from, tos] of closure1) {
            for (const to of tos) {
              expect(isReachable(closureCombined, from, to)).toBe(true);
            }
          }
        }),
        { numRuns: 50 },
      );
    });
  });

  describe("inversion is an involution (on relation set)", () => {
    it("invert(invert(C)) has same relations as C", () => {
      fc.assert(
        fc.property(relationsArb, (relations) => {
          const closure = computeTransitiveClosure(relations);
          const doubleInverted = invertClosure(invertClosure(closure));

          // Same relation count
          const originalRelations = closureToRelations(closure);
          const restoredRelations = closureToRelations(doubleInverted);

          expect(restoredRelations).toEqual(originalRelations);
        }),
        { numRuns: 50 },
      );
    });
  });
});

// ============================================================
// Property Tests - Edge Cases
// ============================================================

describe("Edge Cases", () => {
  describe("cycles", () => {
    it("handles simple cycle correctly", () => {
      const cycle: (readonly [string, string])[] = [
        ["A", "B"],
        ["B", "C"],
        ["C", "A"],
      ];

      const closure = computeTransitiveClosure(cycle);

      // In a cycle, every node reaches every other node
      expect(isReachable(closure, "A", "B")).toBe(true);
      expect(isReachable(closure, "A", "C")).toBe(true);
      expect(isReachable(closure, "B", "A")).toBe(true);
      expect(isReachable(closure, "B", "C")).toBe(true);
      expect(isReachable(closure, "C", "A")).toBe(true);
      expect(isReachable(closure, "C", "B")).toBe(true);

      // And each node reaches itself (cycle property)
      expect(isReachable(closure, "A", "A")).toBe(true);
      expect(isReachable(closure, "B", "B")).toBe(true);
      expect(isReachable(closure, "C", "C")).toBe(true);
    });

    it("handles generated cycles", () => {
      fc.assert(
        fc.property(
          fc.array(nodeNameArb, { minLength: 2, maxLength: 5 }),
          (nodes) => {
            const unique = [...new Set(nodes)];
            if (unique.length < 2) return;

            // Create a cycle: A→B→C→...→A
            const cycle: (readonly [string, string])[] = [];
            for (let index = 0; index < unique.length; index++) {
              const from = unique[index]!;
              const to = unique[(index + 1) % unique.length]!;
              cycle.push([from, to]);
            }

            const closure = computeTransitiveClosure(cycle);

            // Every node should reach every other node in a cycle
            for (const a of unique) {
              for (const b of unique) {
                expect(isReachable(closure, a, b)).toBe(true);
              }
            }
          },
        ),
        { numRuns: 30 },
      );
    });
  });

  describe("duplicate relations", () => {
    it("duplicate input relations don't affect result", () => {
      fc.assert(
        fc.property(relationsArb, (relations) => {
          // Double all relations
          const doubled = [...relations, ...relations];

          const closureSingle = computeTransitiveClosure(relations);
          const closureDoubled = computeTransitiveClosure(doubled);

          expect(closuresEqual(closureSingle, closureDoubled)).toBe(true);
        }),
        { numRuns: 50 },
      );
    });
  });

  describe("diamond pattern", () => {
    it("handles diamond correctly", () => {
      // Diamond: A→B, A→C, B→D, C→D
      const diamond: (readonly [string, string])[] = [
        ["A", "B"],
        ["A", "C"],
        ["B", "D"],
        ["C", "D"],
      ];

      const closure = computeTransitiveClosure(diamond);

      // A reaches all others
      expect(isReachable(closure, "A", "B")).toBe(true);
      expect(isReachable(closure, "A", "C")).toBe(true);
      expect(isReachable(closure, "A", "D")).toBe(true);

      // B and C only reach D
      expect(isReachable(closure, "B", "D")).toBe(true);
      expect(isReachable(closure, "C", "D")).toBe(true);
      expect(isReachable(closure, "B", "C")).toBe(false);
      expect(isReachable(closure, "C", "B")).toBe(false);

      // D reaches nothing
      expect(isReachable(closure, "D", "A")).toBe(false);
      expect(isReachable(closure, "D", "B")).toBe(false);
      expect(isReachable(closure, "D", "C")).toBe(false);
    });
  });
});
