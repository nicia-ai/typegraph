/**
 * Property Tests — Compiler Passes
 *
 * Tests invariants of the compiler pass framework, vector pass,
 * and limit resolution using fast-check.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { ValueType, VectorSimilarityPredicate } from "../../src/query/ast";
import {
  type CompilerPass,
  runCompilerPass,
} from "../../src/query/compiler/passes/runner";
import { resolveVectorAwareLimit } from "../../src/query/compiler/passes/vector";
import {
  isInSubqueryTypeCompatible,
  isUnsupportedInSubqueryValueType,
} from "../../src/query/subquery-utils";

// ============================================================
// runCompilerPass Properties
// ============================================================

describe("Compiler Pass Framework Properties", () => {
  it("execute output is passed to update", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (initialValue, passOutput) => {
        interface TestState {
          value: number;
        }

        const pass: CompilerPass<TestState, "test", number> = {
          name: "test",
          execute: () => passOutput,
          update: (state, output) => ({ value: state.value + output }),
        };

        const result = runCompilerPass({ value: initialValue }, pass);
        expect(result.state.value).toBe(initialValue + passOutput);
      }),
      { numRuns: 100 },
    );
  });

  it("identity pass preserves state", () => {
    fc.assert(
      fc.property(
        fc.record({
          count: fc.integer(),
          label: fc.string(),
          active: fc.boolean(),
        }),
        (state) => {
          const pass: CompilerPass<typeof state, "noop", undefined> = {
            name: "noop",
            // eslint-disable-next-line @typescript-eslint/no-empty-function
            execute: () => {},
            update: (currentState) => currentState,
          };

          const result = runCompilerPass(state, pass);
          expect(result.state).toEqual(state);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("passes compose sequentially (output of one feeds into next)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 10 }),
        (initial, delta1, delta2) => {
          interface S {
            value: number;
          }

          const pass1: CompilerPass<S, "add1", number> = {
            name: "add1",
            execute: () => delta1,
            update: (state, output) => ({ value: state.value + output }),
          };

          const pass2: CompilerPass<S, "add2", number> = {
            name: "add2",
            execute: () => delta2,
            update: (state, output) => ({ value: state.value + output }),
          };

          const after1 = runCompilerPass({ value: initial }, pass1);
          const after2 = runCompilerPass(after1.state, pass2);

          expect(after2.state.value).toBe(initial + delta1 + delta2);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ============================================================
// resolveVectorAwareLimit Properties
// ============================================================

describe("Vector-Aware Limit Resolution Properties", () => {
  const vectorPredicateArb: fc.Arbitrary<VectorSimilarityPredicate> = fc.record(
    {
      __type: fc.constant("vector_similarity" as const),
      field: fc.constant({
        __type: "field_ref" as const,
        alias: "p",
        path: ["props", "embedding"],
      }),
      queryEmbedding: fc.array(
        fc.double({ noNaN: true, min: -1e10, max: 1e10 }),
        {
          minLength: 3,
          maxLength: 3,
        },
      ),
      metric: fc.constantFrom("cosine", "l2", "inner_product") as fc.Arbitrary<
        VectorSimilarityPredicate["metric"]
      >,
      limit: fc.integer({ min: 1, max: 10_000 }),
    },
  );

  it("returns undefined when both astLimit and vectorPredicate are undefined", () => {
    expect(resolveVectorAwareLimit()).toBeUndefined();
  });

  it("returns astLimit when no vector predicate", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (astLimit) => {
        expect(resolveVectorAwareLimit(astLimit)).toBe(astLimit);
      }),
      { numRuns: 50 },
    );
  });

  it("returns vector limit when astLimit is undefined", () => {
    fc.assert(
      fc.property(vectorPredicateArb, (vectorPredicate) => {
        expect(resolveVectorAwareLimit(undefined, vectorPredicate)).toBe(
          vectorPredicate.limit,
        );
      }),
      { numRuns: 50 },
    );
  });

  it("returns the minimum of astLimit and vector limit", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        vectorPredicateArb,
        (astLimit, vectorPredicate) => {
          const result = resolveVectorAwareLimit(astLimit, vectorPredicate);
          expect(result).toBe(Math.min(astLimit, vectorPredicate.limit));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("effective limit is always <= astLimit when both present", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        vectorPredicateArb,
        (astLimit, vectorPredicate) => {
          const result = resolveVectorAwareLimit(astLimit, vectorPredicate);
          expect(result).toBeLessThanOrEqual(astLimit);
          expect(result).toBeLessThanOrEqual(vectorPredicate.limit);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns undefined only when both inputs are undefined", () => {
    const result = resolveVectorAwareLimit();
    expect(result).toBeUndefined();
  });
});

// ============================================================
// Subquery Type Compatibility Properties
// ============================================================

describe("Subquery Type Compatibility Properties", () => {
  const scalarTypes: ValueType[] = ["string", "number", "boolean", "date"];
  const unsupportedTypes: ValueType[] = ["array", "object", "embedding"];
  const allTypes: ValueType[] = [
    ...scalarTypes,
    ...unsupportedTypes,
    "unknown",
  ];

  const valueTypeArb = fc.constantFrom(...allTypes);
  const scalarTypeArb = fc.constantFrom(...scalarTypes);

  it("type compatibility is reflexive for all types", () => {
    fc.assert(
      fc.property(valueTypeArb, (type) => {
        // A type is always compatible with itself (after normalization)
        // "unknown" normalizes to undefined, which is always compatible
        expect(isInSubqueryTypeCompatible(type, type)).toBe(true);
      }),
      { numRuns: 20 },
    );
  });

  it("type compatibility is symmetric", () => {
    fc.assert(
      fc.property(
        fc.option(valueTypeArb),
        fc.option(valueTypeArb),
        (left, right) => {
          const leftValue = left ?? undefined;
          const rightValue = right ?? undefined;
          expect(isInSubqueryTypeCompatible(leftValue, rightValue)).toBe(
            isInSubqueryTypeCompatible(rightValue, leftValue),
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("undefined is compatible with everything", () => {
    fc.assert(
      fc.property(fc.option(valueTypeArb), (type) => {
        expect(isInSubqueryTypeCompatible(undefined, type ?? undefined)).toBe(
          true,
        );
        expect(isInSubqueryTypeCompatible(type ?? undefined)).toBe(true);
      }),
      { numRuns: 30 },
    );
  });

  it("all scalar types are supported for IN subquery", () => {
    fc.assert(
      fc.property(scalarTypeArb, (type) => {
        expect(isUnsupportedInSubqueryValueType(type)).toBe(false);
      }),
      { numRuns: 10 },
    );
  });

  it("complex types are unsupported for IN subquery", () => {
    fc.assert(
      fc.property(fc.constantFrom(...unsupportedTypes), (type) => {
        expect(isUnsupportedInSubqueryValueType(type)).toBe(true);
      }),
      { numRuns: 10 },
    );
  });

  it("different scalar types are incompatible", () => {
    fc.assert(
      fc.property(scalarTypeArb, scalarTypeArb, (left, right) => {
        fc.pre(left !== right);
        expect(isInSubqueryTypeCompatible(left, right)).toBe(false);
      }),
      { numRuns: 50 },
    );
  });
});
