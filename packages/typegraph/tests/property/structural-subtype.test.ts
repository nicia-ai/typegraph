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
import { structuralSubtypeProjection } from "../../src/schema/structural-subtype-projection";
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
          // A typed catchall or a record constrains the added key too.
          fc.pre(
            parent.additionalProperties === false ||
              (typeof parent.additionalProperties === "object" &&
                Object.keys(parent.additionalProperties).length === 0),
          );

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

type StringCheck = (schema: z._ZodString) => z._ZodString;
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

/**
 * Bases whose own format check the projection loses once a pattern-stated
 * format follows it.
 */
const FORMAT_BASES: readonly (() => z._ZodString)[] = [
  () => z.url(),
  () => z.httpUrl(),
  () => z.jwt(),
  () => z.stringFormat("even-length", (value) => value.length % 2 === 0),
];

const OVERWRITE_CHECKS: readonly StringCheck[] = [
  (s) => s.trim(),
  (s) => s.toLowerCase(),
  (s) => s.toUpperCase(),
  (s) => s.normalize(),
];

/**
 * A bounded string parent. A lossy one also draws a format base and
 * overwrite checks, which the JSON Schema projection does not state.
 */
function stringParentArb(
  patternPool: readonly string[],
  options: Readonly<{ lossy: boolean }>,
): fc.Arbitrary<z._ZodString> {
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
  const checkArb =
    options.lossy ?
      fc.oneof(boundArb, fc.constantFrom(...OVERWRITE_CHECKS))
    : boundArb;
  const baseArb =
    options.lossy ?
      fc.constantFrom<() => z._ZodString>(() => z.string(), ...FORMAT_BASES)
    : fc.constant<() => z._ZodString>(() => z.string());
  return fc
    .record({
      base: baseArb,
      checks: fc.array(checkArb, { maxLength: 3 }),
      patternCheck: fc.option(patternCheckArb, { nil: undefined }),
      patternFirst: fc.boolean(),
    })
    .map(({ base, checks, patternCheck, patternFirst }) => {
      const pattern = patternCheck === undefined ? [] : [patternCheck];
      return withChecks(
        base(),
        patternFirst ? [...pattern, ...checks] : [...checks, ...pattern],
      );
    });
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

function pinnedStrings(
  values: readonly string[],
): z.ZodEnum<Readonly<Record<string, string>>> {
  return z.enum(values as [string, ...string[]]);
}

function pinnedNumbers(values: readonly number[]): z.ZodType {
  return z.literal(values);
}

/** Values JSON cannot carry: the projection writes each as `null`. */
const NON_JSON_NUMBER_POOL = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

/** Strings an overwrite or a lost format check treats differently. */
const LOSSY_STRING_POOL = [
  " a",
  " ab",
  "ß",
  "\u0958",
  "https://",
  "eyX",
  "ABC",
];

const LITERAL_POOL = [
  ...STRING_VALUE_POOL,
  ...LOSSY_STRING_POOL,
  ...NUMBER_VALUE_POOL,
  ...NON_JSON_NUMBER_POOL,
  // eslint-disable-next-line unicorn/no-null -- JSON null is a literal value
  null,
  true,
];

type PinnedChild = Readonly<{
  schema: z.ZodType;
  samples: readonly unknown[];
}>;

/**
 * A child pinned to a finite value set, bare or under the wrappers the
 * comparison walks: nullable, a union of two pinned members, and a record
 * whose keys are pinned.
 */
function pinnedChildArb(): fc.Arbitrary<PinnedChild> {
  const literalsArb = valueSubsetArb(LITERAL_POOL);
  const keysArb = valueSubsetArb([...STRING_VALUE_POOL, ...LOSSY_STRING_POOL]);
  return fc.oneof(
    literalsArb.map((values) => ({
      schema: z.literal(values),
      samples: values,
    })),
    literalsArb.map((values) => ({
      schema: z.literal(values).nullable(),
      // eslint-disable-next-line unicorn/no-null -- the value `.nullable()` adds
      samples: [...values, null],
    })),
    fc.tuple(literalsArb, literalsArb).map(([first, second]) => ({
      schema: z.union([z.literal(first), z.literal(second)]),
      samples: [...first, ...second],
    })),
    keysArb.map((keys) => ({
      schema: z.partialRecord(pinnedStrings(keys), z.string()),
      samples: keys.map((key) => ({ [key]: "value" })),
    })),
  );
}

function parentArb(): fc.Arbitrary<z.ZodType> {
  const stringArb = stringParentArb(
    [...AGREEING_PATTERN_POOL, ...DIVERGENT_PATTERN_POOL],
    { lossy: true },
  );
  return fc.oneof(
    stringArb,
    stringArb.map((parent) => parent.nullable()),
    stringArb.map((parent) => z.record(parent, z.string())),
    numberParentArb(),
    numberParentArb().map((parent) => parent.nullable()),
    fc.constantFrom<z.ZodType>(
      z.boolean(),
      z.null(),
      z.object({}),
      z.enum(["a"]).or(z.boolean()),
    ),
  );
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
        stringParentArb(AGREEING_PATTERN_POOL, { lossy: false }),
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

  it("P8: over the live projection, an accepted finite child admits no value the parent refuses", () => {
    fc.assert(
      fc.property(pinnedChildArb(), parentArb(), (child, parent) => {
        const result = isStructuralSubtype(
          structuralSubtypeProjection(z.object({ field: child.schema })),
          structuralSubtypeProjection(z.object({ field: parent })),
        );
        if (result.verdict !== "subtype") return;
        for (const sample of child.samples) {
          const stored = child.schema.safeParse(sample);
          if (!stored.success) continue;
          expect({
            sample,
            admitted: parent.safeParse(stored.data).success,
          }).toEqual({ sample, admitted: true });
        }
      }),
      { numRuns: 10_000 },
    );
  });
});
