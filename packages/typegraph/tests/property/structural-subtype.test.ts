/**
 * Property-based tests for the structural subtyping predicate.
 *
 * Uses `comparableSchemaArb` / `tightenArb` from `./arbitraries.ts` — shared
 * there so the child/parent-agreement
 * property test can reuse the same generators rather than re-deriving them.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { isObjectSchema } from "../../src/schema/migration";
import { serializeSchemaProperties } from "../../src/schema/serializer";
import { isStructuralSubtype } from "../../src/schema/structural-subtype";
import { type JsonSchema } from "../../src/schema/types";
import { comparableSchemaArb, tightenArb } from "./arbitraries";

// A property name guaranteed absent from every schema `comparableSchemaArb`
// generates (its object fields are drawn only from "fieldA"/"fieldB"/"fieldC").
const FRESH_PROPERTY_NAME = "freshRequiredField";

function objectSchemaArb(): fc.Arbitrary<JsonSchema> {
  return comparableSchemaArb.filter((schema) => isObjectSchema(schema));
}

function objectSchemaWithRequiredPropertyArb(): fc.Arbitrary<JsonSchema> {
  return objectSchemaArb().filter(
    (schema) => (schema.required?.length ?? 0) > 0,
  );
}

describe("structural subtyping properties", () => {
  it("P1: reflexivity — every comparable schema is a subtype of itself", () => {
    fc.assert(
      fc.property(comparableSchemaArb, (schema) => {
        expect(isStructuralSubtype(schema, schema)).toEqual({
          verdict: "subtype",
        });
      }),
    );
  });

  it("P2: tightening is subtyping — tighten(p) is always a subtype of p", () => {
    fc.assert(
      fc.property(
        comparableSchemaArb.chain((parent) =>
          tightenArb(parent).map((child) => [child, parent] as const),
        ),
        ([child, parent]) => {
          expect(isStructuralSubtype(child, parent)).toEqual({
            verdict: "subtype",
          });
        },
      ),
    );
  });

  it("P3: transitivity over tightening chains — tighten(tighten(p)) is still a subtype of p", () => {
    fc.assert(
      fc.property(
        comparableSchemaArb.chain((parent) =>
          tightenArb(parent).chain((intermediate) =>
            tightenArb(intermediate).map((child) => [child, parent] as const),
          ),
        ),
        ([child, parent]) => {
          const result = isStructuralSubtype(child, parent);
          if (result.verdict !== "subtype") {
            // Per the plan: a P3 counterexample is a design defect in the
            // rule set, not a test problem — surface the triple rather than
            // weakening the property.
            throw new Error(
              `Transitivity failed for child=${JSON.stringify(child)} parent=${JSON.stringify(
                parent,
              )}: got ${JSON.stringify(result)}`,
            );
          }
          expect(result).toEqual({ verdict: "subtype" });
        },
      ),
    );
  });

  it("P4: a child adding a required field is a subtype, and the reverse direction is not", () => {
    fc.assert(
      fc.property(
        objectSchemaArb(),
        comparableSchemaArb,
        (parent, newPropertySchema) => {
          const parentProps = parent.properties ?? {};
          fc.pre(!Object.hasOwn(parentProps, FRESH_PROPERTY_NAME));

          const child: JsonSchema = {
            ...parent,
            properties: {
              ...parentProps,
              [FRESH_PROPERTY_NAME]: newPropertySchema,
            },
            required: [...(parent.required ?? []), FRESH_PROPERTY_NAME],
          };

          expect(isStructuralSubtype(child, parent)).toEqual({
            verdict: "subtype",
          });

          const reverse = isStructuralSubtype(parent, child);
          expect(reverse).toMatchObject({
            verdict: "not-subtype",
            reason: "missing-required-property",
          });
        },
      ),
    );
  });

  it("P5: relaxing a required field to optional is not subtyping", () => {
    fc.assert(
      fc.property(objectSchemaWithRequiredPropertyArb(), (parent) => {
        const parentRequired = parent.required ?? [];
        fc.pre(parentRequired.length > 0);
        const [droppedName] = parentRequired;

        const child: JsonSchema = {
          ...parent,
          required: parentRequired.filter((name) => name !== droppedName),
        };

        const result = isStructuralSubtype(child, parent);
        expect(result).toMatchObject({
          verdict: "not-subtype",
          reason: "optional-in-child-required-in-parent",
        });
      }),
    );
  });

  it("P6: the verdict is always total and well-shaped, and never throws", () => {
    fc.assert(
      fc.property(
        comparableSchemaArb,
        comparableSchemaArb,
        (schemaA, schemaB) => {
          const result = isStructuralSubtype(schemaA, schemaB);
          const isWellShaped =
            result.verdict === "subtype" ?
              Object.keys(result).length === 1
            : typeof result.reason === "string" && Array.isArray(result.path);
          expect(isWellShaped).toBe(true);
        },
      ),
    );
  });
});

// ============================================================
// Finite value sets under bounded parents
// ============================================================

type StringCheck = (schema: z.ZodString) => z.ZodString;
type NumberCheck = (schema: z.ZodNumber) => z.ZodNumber;

function withChecks<S>(schema: S, checks: readonly ((schema: S) => S)[]): S {
  let checked = schema;
  for (const check of checks) checked = check(checked);
  return checked;
}

/**
 * Patterns whose flagless reading (how Zod tests them) and Unicode reading
 * (how a JSON Schema validator compiles them) agree on every string in
 * {@link AGREEING_STRING_POOL}.
 */
const AGREEING_PATTERN_POOL = [
  "^a",
  "b$",
  "^[a-c]+$",
  "^.{2}$",
  String.raw`\d`,
];

/**
 * Patterns whose two readings disagree on some string in
 * {@link STRING_VALUE_POOL}, or whose Unicode reading does not compile.
 */
const DIVERGENT_PATTERN_POOL = [
  "^.$",
  String.raw`^\p{L}+$`,
  String.raw`^[\w-.]+$`,
  String.raw`^\-`,
];

/** Strings without an astral character, so code points equal UTF-16 units. */
const AGREEING_STRING_POOL = ["", "a", "b", "ab", "abc", "ba", "A", "1", "é"];

const STRING_VALUE_POOL = [
  ...AGREEING_STRING_POOL,
  "-",
  "p{L}",
  "😀",
  "a😀",
  "\n",
  "aaaaa",
];

/** Numbers whose shortest decimal has at most two fraction digits. */
const AGREEING_NUMBER_POOL = [
  -3, -1, 0, 1, 2, 3, 4, 6, 10, 0.07, 0.1, 0.2, 0.25, 0.3, 0.5, 1.5, 2.03,
];

const NUMBER_VALUE_POOL = [
  ...AGREEING_NUMBER_POOL,
  -0,
  0.1 + 0.2,
  1e-7,
  1e21,
  5e-324,
  Number.MAX_SAFE_INTEGER,
  2 ** 53,
];

const MULTIPLE_OF_POOL = [2, 3, 0.01, 0.07, 0.1, 0.25];

function stringParentArb(
  patternPool: readonly string[],
): fc.Arbitrary<z.ZodString> {
  const boundArb = fc.oneof(
    fc.nat({ max: 3 }).map(
      (length): StringCheck =>
        (s) =>
          s.min(length),
    ),
    fc.integer({ min: 1, max: 4 }).map(
      (length): StringCheck =>
        (s) =>
          s.max(length),
    ),
  );
  // At most one pattern-bearing check: two project as `allOf`, which the
  // predicate refuses as incomparable.
  const patternCheckArb = fc.oneof(
    fc.constantFrom(...patternPool).map(
      (pattern): StringCheck =>
        (s) =>
          s.regex(new RegExp(pattern)),
    ),
    fc.constantFrom("a", "b").map(
      (prefix): StringCheck =>
        (s) =>
          s.startsWith(prefix),
    ),
    fc.constant<StringCheck>((s) => s.lowercase()),
    fc.constant<StringCheck>((s) => s.includes("a", { position: 1 })),
  );
  return fc
    .tuple(
      fc.array(boundArb, { maxLength: 2 }),
      fc.option(patternCheckArb, { nil: undefined }),
    )
    .map(([bounds, patternCheck]) =>
      withChecks(z.string(), [
        ...bounds,
        ...(patternCheck === undefined ? [] : [patternCheck]),
      ]),
    );
}

function numberParentArb(): fc.Arbitrary<z.ZodNumber> {
  const boundArb = fc.oneof(
    fc.integer({ min: -2, max: 5 }).map(
      (bound): NumberCheck =>
        (s) =>
          s.min(bound),
    ),
    fc.integer({ min: -2, max: 5 }).map(
      (bound): NumberCheck =>
        (s) =>
          s.max(bound),
    ),
    fc.integer({ min: -2, max: 5 }).map(
      (bound): NumberCheck =>
        (s) =>
          s.gt(bound),
    ),
    fc.integer({ min: -2, max: 5 }).map(
      (bound): NumberCheck =>
        (s) =>
          s.lt(bound),
    ),
    fc.constant<NumberCheck>((s) => s.int()),
  );
  // At most one `multipleOf`: two project as `allOf`, which the predicate
  // refuses as incomparable.
  const multipleOfArb = fc.constantFrom(...MULTIPLE_OF_POOL).map(
    (step): NumberCheck =>
      (s) =>
        s.multipleOf(step),
  );
  return fc
    .tuple(
      fc.array(boundArb, { maxLength: 3 }),
      fc.option(multipleOfArb, { nil: undefined }),
    )
    .map(([bounds, multipleOf]) =>
      withChecks(z.number(), [
        ...bounds,
        ...(multipleOf === undefined ? [] : [multipleOf]),
      ]),
    );
}

function valueSubsetArb<T>(pool: readonly T[]): fc.Arbitrary<readonly T[]> {
  return fc.uniqueArray(fc.constantFrom(...pool), {
    minLength: 1,
    maxLength: 4,
  });
}

function pinnedStrings(values: readonly string[]): z.ZodType {
  return z.enum(values as [string, ...string[]]);
}

function pinnedNumbers(values: readonly number[]): z.ZodType {
  return z.literal(values);
}

function finiteVerdict(child: z.ZodType, parent: z.ZodType) {
  return isStructuralSubtype(
    serializeSchemaProperties(child),
    serializeSchemaProperties(parent),
  );
}

function admittedByParent(
  parent: z.ZodType,
  values: readonly unknown[],
): readonly unknown[] {
  return values.filter((value) => parent.safeParse(value).success);
}

describe("structural subtyping properties — finite value sets", () => {
  it("P7: a finite child the parent admits in full is a subtype, wherever the readings agree", () => {
    fc.assert(
      fc.property(
        stringParentArb(AGREEING_PATTERN_POOL),
        valueSubsetArb(AGREEING_STRING_POOL),
        (parent, candidates) => {
          const values = admittedByParent(parent, candidates) as string[];
          fc.pre(values.length > 0);
          expect(finiteVerdict(pinnedStrings(values), parent)).toEqual({
            verdict: "subtype",
          });
        },
      ),
    );
    fc.assert(
      fc.property(
        numberParentArb(),
        valueSubsetArb(AGREEING_NUMBER_POOL),
        (parent, candidates) => {
          const values = admittedByParent(parent, candidates) as number[];
          fc.pre(values.length > 0);
          expect(finiteVerdict(pinnedNumbers(values), parent)).toEqual({
            verdict: "subtype",
          });
        },
      ),
    );
  });

  it("P8: an accepted finite child admits no value the parent's Zod schema refuses", () => {
    fc.assert(
      fc.property(
        stringParentArb([...AGREEING_PATTERN_POOL, ...DIVERGENT_PATTERN_POOL]),
        valueSubsetArb(STRING_VALUE_POOL),
        (parent, values) => {
          const result = finiteVerdict(pinnedStrings(values), parent);
          if (result.verdict !== "subtype") return;
          expect(admittedByParent(parent, values)).toEqual(values);
        },
      ),
      { numRuns: 500 },
    );
    fc.assert(
      fc.property(
        numberParentArb(),
        valueSubsetArb(NUMBER_VALUE_POOL),
        (parent, values) => {
          const result = finiteVerdict(pinnedNumbers(values), parent);
          if (result.verdict !== "subtype") return;
          expect(admittedByParent(parent, values)).toEqual(values);
        },
      ),
      { numRuns: 500 },
    );
  });
});
