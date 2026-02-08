import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  checkCardinality,
  checkDisjointness,
  checkUniqueEdge,
  checkWherePredicate,
  computeUniqueKey,
} from "../../src/constraints";
import { type Collation, type UniqueConstraint } from "../../src/core/types";
import {
  createEmptyClosures,
  KindRegistry,
} from "../../src/registry/kind-registry";

// ============================================================
// Arbitrary Generators
// ============================================================

/**
 * Generate simple property names.
 */
const propertyNameArb = fc.constantFrom(
  "name",
  "email",
  "age",
  "title",
  "status",
  "type",
  "createdAt",
  "deletedAt",
  "archivedAt",
  "value",
  "code",
);

/**
 * Generate property values.
 */
const propertyValueArb = fc.oneof(
  fc.string({ minLength: 0, maxLength: 50 }),
  fc.integer(),
  fc.boolean(),
  // eslint-disable-next-line unicorn/no-useless-undefined -- testing undefined property values
  fc.constant(undefined),
);

/**
 * Generate simple props objects.
 */
const propsArb = fc
  .array(fc.tuple(propertyNameArb, propertyValueArb), {
    minLength: 1,
    maxLength: 5,
  })
  .map((pairs) => {
    const props: Record<string, unknown> = {};
    for (const [key, value] of pairs) {
      props[key] = value;
    }
    return props;
  });

/**
 * Generate collation values.
 */
const collationArb: fc.Arbitrary<Collation> = fc.constantFrom(
  "binary",
  "caseInsensitive",
);

/**
 * Generate kind names.
 */
const kindNameArb = fc.constantFrom(
  "Person",
  "Company",
  "Organization",
  "Animal",
  "Vehicle",
  "Product",
  "Order",
  "User",
  "Admin",
  "Guest",
);

/**
 * Generate node IDs.
 */
const nodeIdArb = fc
  .tuple(fc.constantFrom("node", "n", "id"), fc.integer({ min: 1, max: 9999 }))
  .map(([prefix, number_]) => `${prefix}_${number_}`);

/**
 * Generate edge kind names.
 */
const edgeKindArb = fc.constantFrom(
  "worksAt",
  "owns",
  "likes",
  "follows",
  "manages",
  "contains",
  "references",
  "creates",
  "updates",
);

// ============================================================
// Helper to create a simple KindRegistry
// ============================================================

function createSimpleRegistry(
  disjointPairs: [string, string][] = [],
): KindRegistry {
  const nodeKinds = new Map();
  const edgeKinds = new Map();

  // Normalize disjoint pairs
  const normalizedPairs = new Set<string>();
  for (const [a, b] of disjointPairs) {
    const normalized = a < b ? `${a}|${b}` : `${b}|${a}`;
    normalizedPairs.add(normalized);
  }

  const closures = {
    ...createEmptyClosures(),
    disjointPairs: normalizedPairs,
  };

  return new KindRegistry(nodeKinds, edgeKinds, closures);
}

// ============================================================
// Property Tests - computeUniqueKey
// ============================================================

describe("computeUniqueKey Properties", () => {
  describe("determinism", () => {
    it("same props and fields produce same key", () => {
      fc.assert(
        fc.property(
          propsArb,
          fc.array(propertyNameArb, { minLength: 1, maxLength: 3 }),
          collationArb,
          (props, fields, collation) => {
            const key1 = computeUniqueKey(props, fields, collation);
            const key2 = computeUniqueKey(props, fields, collation);

            expect(key1).toBe(key2);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("different props can produce different keys", () => {
      fc.assert(
        fc.property(
          fc.tuple(propertyNameArb, fc.string({ minLength: 1, maxLength: 10 })),
          fc.tuple(propertyNameArb, fc.string({ minLength: 1, maxLength: 10 })),
          collationArb,
          ([field1, value1], [_field2, value2], collation) => {
            // Use same field name but different values
            const props1 = { [field1]: value1 };
            const props2 = { [field1]: value2 };

            if (value1 === value2) return; // Skip if same

            const key1 = computeUniqueKey(props1, [field1], collation);
            const key2 = computeUniqueKey(props2, [field1], collation);

            // Keys should differ (unless case-insensitive makes them same)
            const shouldDiffer =
              collation === "binary" ||
              value1.toLowerCase() !== value2.toLowerCase();

            if (!shouldDiffer) return;
            expect(key1).not.toBe(key2);
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  describe("collation behavior", () => {
    it("binary collation preserves case", () => {
      const props = { name: "Alice" };
      const key = computeUniqueKey(props, ["name"], "binary");

      expect(key).toContain("Alice");
      expect(key).not.toContain("alice");
    });

    it("caseInsensitive collation lowercases strings", () => {
      const props = { name: "ALICE" };
      const key = computeUniqueKey(props, ["name"], "caseInsensitive");

      expect(key).toContain("alice");
      expect(key).not.toContain("ALICE");
    });

    it("caseInsensitive makes case variants equal", () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1, maxLength: 20 }), (value) => {
          const upper = { name: value.toUpperCase() };
          const lower = { name: value.toLowerCase() };

          const keyUpper = computeUniqueKey(upper, ["name"], "caseInsensitive");
          const keyLower = computeUniqueKey(lower, ["name"], "caseInsensitive");

          expect(keyUpper).toBe(keyLower);
        }),
        { numRuns: 50 },
      );
    });

    it("binary keeps case variants different", () => {
      fc.assert(
        fc.property(
          fc
            .string({ minLength: 1, maxLength: 20 })
            .filter((s) => s.toLowerCase() !== s.toUpperCase()),
          (value) => {
            const upper = { name: value.toUpperCase() };
            const lower = { name: value.toLowerCase() };

            const keyUpper = computeUniqueKey(upper, ["name"], "binary");
            const keyLower = computeUniqueKey(lower, ["name"], "binary");

            expect(keyUpper).not.toBe(keyLower);
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  describe("null handling", () => {
    it("null and undefined produce same marker", () => {
      // eslint-disable-next-line unicorn/no-null -- testing null handling
      const propsNull = { name: null };
      const propsUndef = { name: undefined };

      const keyNull = computeUniqueKey(propsNull, ["name"], "binary");
      const keyUndef = computeUniqueKey(propsUndef, ["name"], "binary");

      expect(keyNull).toBe(keyUndef);
    });

    it("missing field produces null marker", () => {
      const props = { age: 30 };
      const key = computeUniqueKey(props, ["name"], "binary");

      // Should contain null marker
      expect(key).toBe("\0");
    });
  });

  describe("multi-field keys", () => {
    it("field order matters", () => {
      const props = { name: "Alice", age: "30" };

      const key1 = computeUniqueKey(props, ["name", "age"], "binary");
      const key2 = computeUniqueKey(props, ["age", "name"], "binary");

      expect(key1).not.toBe(key2);
    });

    it("keys are joined with separator", () => {
      const props = { a: "x", b: "y" };
      const key = computeUniqueKey(props, ["a", "b"], "binary");

      // Should contain null separator between fields
      expect(key).toBe("x\0y");
    });
  });

  describe("type coercion", () => {
    it("numbers are converted to strings", () => {
      const props = { age: 42 };
      const key = computeUniqueKey(props, ["age"], "binary");

      expect(key).toBe("42");
    });

    it("booleans are converted to strings", () => {
      const propsTrue = { active: true };
      const propsFalse = { active: false };

      const keyTrue = computeUniqueKey(propsTrue, ["active"], "binary");
      const keyFalse = computeUniqueKey(propsFalse, ["active"], "binary");

      expect(keyTrue).toBe("true");
      expect(keyFalse).toBe("false");
    });
  });
});

// ============================================================
// Property Tests - checkWherePredicate
// ============================================================

describe("checkWherePredicate Properties", () => {
  describe("no where clause", () => {
    it("always returns true when no where clause", () => {
      fc.assert(
        fc.property(propsArb, (props) => {
          const constraint: UniqueConstraint = {
            name: "test",
            fields: ["name"],
            scope: "kind",
            collation: "binary",
            // No where clause
          };

          expect(checkWherePredicate(constraint, props)).toBe(true);
        }),
        { numRuns: 50 },
      );
    });
  });

  describe("isNull predicate", () => {
    it("isNull returns true for null values", () => {
      const constraint: UniqueConstraint = {
        name: "test",
        fields: ["name"],
        scope: "kind",
        collation: "binary",
        where: (p) => p.status!.isNull(),
      };

      // Note: the where predicate context is built from the props keys,
      // so the field must exist in props (even if null/undefined)
      // eslint-disable-next-line unicorn/no-null -- testing null handling
      expect(checkWherePredicate(constraint, { status: null })).toBe(true);
      expect(checkWherePredicate(constraint, { status: undefined })).toBe(true);
    });

    it("isNull returns false for non-null values", () => {
      fc.assert(
        fc.property(
          fc.oneof(fc.string(), fc.integer(), fc.boolean()),
          (value) => {
            const constraint: UniqueConstraint = {
              name: "test",
              fields: ["name"],
              scope: "kind",
              collation: "binary",
              where: (p) => p.status!.isNull(),
            };

            expect(checkWherePredicate(constraint, { status: value })).toBe(
              false,
            );
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  describe("isNotNull predicate", () => {
    it("isNotNull returns true for non-null values", () => {
      fc.assert(
        fc.property(
          fc.oneof(fc.string(), fc.integer(), fc.boolean()),
          (value) => {
            const constraint: UniqueConstraint = {
              name: "test",
              fields: ["name"],
              scope: "kind",
              collation: "binary",
              where: (p) => p.status!.isNotNull(),
            };

            expect(checkWherePredicate(constraint, { status: value })).toBe(
              true,
            );
          },
        ),
        { numRuns: 50 },
      );
    });

    it("isNotNull returns false for null values", () => {
      const constraint: UniqueConstraint = {
        name: "test",
        fields: ["name"],
        scope: "kind",
        collation: "binary",
        where: (p) => p.status!.isNotNull(),
      };

      // eslint-disable-next-line unicorn/no-null -- testing null handling
      expect(checkWherePredicate(constraint, { status: null })).toBe(false);
      expect(checkWherePredicate(constraint, { status: undefined })).toBe(
        false,
      );
    });
  });

  describe("isNull and isNotNull duality", () => {
    it("isNull and isNotNull are mutually exclusive", () => {
      fc.assert(
        fc.property(propertyValueArb, (value) => {
          const props = { field: value };

          const constraintNull: UniqueConstraint = {
            name: "test",
            fields: ["name"],
            scope: "kind",
            collation: "binary",
            where: (p) => p.field!.isNull(),
          };

          const constraintNotNull: UniqueConstraint = {
            name: "test",
            fields: ["name"],
            scope: "kind",
            collation: "binary",
            where: (p) => p.field!.isNotNull(),
          };

          const isNull = checkWherePredicate(constraintNull, props);
          const isNotNull = checkWherePredicate(constraintNotNull, props);

          // Exactly one should be true (XOR)
          expect(isNull !== isNotNull).toBe(true);
        }),
        { numRuns: 50 },
      );
    });
  });
});

// ============================================================
// Property Tests - checkCardinality
// ============================================================

describe("checkCardinality Properties", () => {
  describe("many cardinality", () => {
    it("many never returns error", () => {
      fc.assert(
        fc.property(
          edgeKindArb,
          kindNameArb,
          nodeIdArb,
          fc.integer({ min: 0, max: 1000 }),
          fc.boolean(),
          (edgeKind, fromKind, fromId, count, hasActive) => {
            const result = checkCardinality(
              edgeKind,
              fromKind,
              fromId,
              "many",
              count,
              hasActive,
            );

            expect(result).toBeUndefined();
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  describe("one cardinality", () => {
    it("one allows zero existing edges", () => {
      fc.assert(
        fc.property(
          edgeKindArb,
          kindNameArb,
          nodeIdArb,
          (edgeKind, fromKind, fromId) => {
            const result = checkCardinality(
              edgeKind,
              fromKind,
              fromId,
              "one",
              0,
              false,
            );

            expect(result).toBeUndefined();
          },
        ),
        { numRuns: 30 },
      );
    });

    it("one rejects any existing edges", () => {
      fc.assert(
        fc.property(
          edgeKindArb,
          kindNameArb,
          nodeIdArb,
          fc.integer({ min: 1, max: 100 }),
          (edgeKind, fromKind, fromId, count) => {
            const result = checkCardinality(
              edgeKind,
              fromKind,
              fromId,
              "one",
              count,
              false,
            );

            expect(result).toBeDefined();
            expect(result!.message).toContain("one");
          },
        ),
        { numRuns: 30 },
      );
    });

    it("one is monotonic: more edges = still error", () => {
      fc.assert(
        fc.property(
          edgeKindArb,
          kindNameArb,
          nodeIdArb,
          fc.integer({ min: 1, max: 50 }),
          fc.integer({ min: 1, max: 50 }),
          (edgeKind, fromKind, fromId, count1, count2) => {
            const result1 = checkCardinality(
              edgeKind,
              fromKind,
              fromId,
              "one",
              count1,
              false,
            );
            const result2 = checkCardinality(
              edgeKind,
              fromKind,
              fromId,
              "one",
              count1 + count2,
              false,
            );

            // If error at count1, still error at count1 + count2
            if (result1 === undefined) return;
            expect(result2).toBeDefined();
          },
        ),
        { numRuns: 30 },
      );
    });
  });

  describe("oneActive cardinality", () => {
    it("oneActive allows when no active edge", () => {
      fc.assert(
        fc.property(
          edgeKindArb,
          kindNameArb,
          nodeIdArb,
          fc.integer({ min: 0, max: 100 }),
          (edgeKind, fromKind, fromId, count) => {
            const result = checkCardinality(
              edgeKind,
              fromKind,
              fromId,
              "oneActive",
              count,
              false, // No active edge
            );

            expect(result).toBeUndefined();
          },
        ),
        { numRuns: 30 },
      );
    });

    it("oneActive rejects when active edge exists", () => {
      fc.assert(
        fc.property(
          edgeKindArb,
          kindNameArb,
          nodeIdArb,
          (edgeKind, fromKind, fromId) => {
            const result = checkCardinality(
              edgeKind,
              fromKind,
              fromId,
              "oneActive",
              1,
              true, // Has active edge
            );

            expect(result).toBeDefined();
            expect(result!.message).toContain("oneActive");
          },
        ),
        { numRuns: 30 },
      );
    });
  });

  describe("unique cardinality", () => {
    it("unique passes through (checked separately)", () => {
      fc.assert(
        fc.property(
          edgeKindArb,
          kindNameArb,
          nodeIdArb,
          fc.integer({ min: 0, max: 100 }),
          fc.boolean(),
          (edgeKind, fromKind, fromId, count, hasActive) => {
            const result = checkCardinality(
              edgeKind,
              fromKind,
              fromId,
              "unique",
              count,
              hasActive,
            );

            // unique is checked via checkUniqueEdge instead
            expect(result).toBeUndefined();
          },
        ),
        { numRuns: 30 },
      );
    });
  });
});

// ============================================================
// Property Tests - checkUniqueEdge
// ============================================================

describe("checkUniqueEdge Properties", () => {
  it("allows when no existing edge", () => {
    fc.assert(
      fc.property(
        edgeKindArb,
        kindNameArb,
        nodeIdArb,
        kindNameArb,
        nodeIdArb,
        (edgeKind, fromKind, fromId, toKind, toId) => {
          const result = checkUniqueEdge(
            edgeKind,
            fromKind,
            fromId,
            toKind,
            toId,
            0, // No existing
          );

          expect(result).toBeUndefined();
        },
      ),
      { numRuns: 50 },
    );
  });

  it("rejects when edge already exists", () => {
    fc.assert(
      fc.property(
        edgeKindArb,
        kindNameArb,
        nodeIdArb,
        kindNameArb,
        nodeIdArb,
        fc.integer({ min: 1, max: 10 }),
        (edgeKind, fromKind, fromId, toKind, toId, count) => {
          const result = checkUniqueEdge(
            edgeKind,
            fromKind,
            fromId,
            toKind,
            toId,
            count,
          );

          expect(result).toBeDefined();
          expect(result!.message).toContain("unique");
        },
      ),
      { numRuns: 50 },
    );
  });

  it("is monotonic: more edges = still error", () => {
    fc.assert(
      fc.property(
        edgeKindArb,
        kindNameArb,
        nodeIdArb,
        kindNameArb,
        nodeIdArb,
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 5 }),
        (edgeKind, fromKind, fromId, toKind, toId, count1, count2) => {
          const result1 = checkUniqueEdge(
            edgeKind,
            fromKind,
            fromId,
            toKind,
            toId,
            count1,
          );
          const result2 = checkUniqueEdge(
            edgeKind,
            fromKind,
            fromId,
            toKind,
            toId,
            count1 + count2,
          );

          // If error at count1, still error at count1 + count2
          if (result1 === undefined) return;
          expect(result2).toBeDefined();
        },
      ),
      { numRuns: 30 },
    );
  });
});

// ============================================================
// Property Tests - checkDisjointness
// ============================================================

describe("checkDisjointness Properties", () => {
  describe("symmetry", () => {
    it("disjointness is symmetric", () => {
      fc.assert(
        fc.property(
          nodeIdArb,
          kindNameArb,
          kindNameArb,
          (nodeId, kind1, kind2) => {
            // Create registry with disjoint pair
            const registry = createSimpleRegistry([[kind1, kind2]]);

            // Check both directions
            const error1 = checkDisjointness(nodeId, kind1, [kind2], registry);
            const error2 = checkDisjointness(nodeId, kind2, [kind1], registry);

            // Both should return error (or neither if same kind)
            if (kind1 === kind2) return;
            expect(error1).toBeDefined();
            expect(error2).toBeDefined();
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  describe("non-disjoint kinds", () => {
    it("allows non-disjoint kinds", () => {
      fc.assert(
        fc.property(
          nodeIdArb,
          kindNameArb,
          fc.array(kindNameArb, { minLength: 1, maxLength: 5 }),
          (nodeId, newKind, existingKinds) => {
            // Empty registry = no disjoint pairs
            const registry = createSimpleRegistry([]);

            const result = checkDisjointness(
              nodeId,
              newKind,
              existingKinds,
              registry,
            );

            expect(result).toBeUndefined();
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  describe("disjoint detection", () => {
    it("detects disjoint pairs", () => {
      const registry = createSimpleRegistry([
        ["Person", "Organization"],
        ["Animal", "Vehicle"],
      ]);

      // Person and Organization are disjoint
      expect(
        checkDisjointness("n1", "Person", ["Organization"], registry),
      ).toBeDefined();
      expect(
        checkDisjointness("n1", "Organization", ["Person"], registry),
      ).toBeDefined();

      // Animal and Vehicle are disjoint
      expect(
        checkDisjointness("n2", "Animal", ["Vehicle"], registry),
      ).toBeDefined();

      // Person and Animal are NOT disjoint
      expect(
        checkDisjointness("n3", "Person", ["Animal"], registry),
      ).toBeUndefined();
    });
  });

  describe("multiple existing kinds", () => {
    it("checks against all existing kinds", () => {
      const registry = createSimpleRegistry([["Person", "Organization"]]);

      // Should find the disjoint pair among multiple
      const result = checkDisjointness(
        "n1",
        "Person",
        ["Animal", "Vehicle", "Organization"],
        registry,
      );

      expect(result).toBeDefined();
      expect(result!.message).toContain("Organization");
    });
  });
});
