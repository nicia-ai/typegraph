/**
 * Property Tests — Compiler Passes
 *
 * Tests invariants of the compiler pass framework, vector pass,
 * and limit resolution using fast-check.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { ValueType } from "../../src/query/ast";
import {
  type CompilerPass,
  runCompilerPass,
} from "../../src/query/compiler/passes/runner";
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
