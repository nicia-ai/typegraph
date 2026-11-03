/**
 * Soundness of the live structural subtype check against Zod itself.
 *
 * The oracle is independent of the predicate: a pair the check accepts must
 * have every value the CHILD's Zod schema stores accepted by the PARENT's
 * Zod `safeParse`. Pairs are drawn as plain specs, built into Zod, and
 * compared through `structuralSubtypeProjection` exactly as a live graph's
 * registry compares them. A child is the parent spec under a few random
 * edits (a near miss is where an unsound accept hides) or an unrelated spec.
 *
 * Sample inputs are read the way JSON reads them (an `undefined` member is
 * absent): a non-JSON input such as `{ x: undefined }` passes an exhaustive
 * enum-key record and fails its parent for a reason no stored row can
 * reach. Dates (an invalid one included) and bigints are kept as values,
 * so the nodes that parse them are judged on them too. Fallbacks
 * (`.default()`, `.catch()`, `.prefault()`), pipes, `z.preprocess()` and
 * records with optional values are drawn around any node.
 *
 * Unconvertible constructs (transforms, custom checks, dates, embeddings)
 * are drawn in variants that share a Zod node type, and each draws a slot:
 * the two sides of a pair reuse one instance per variant and slot, the way a
 * field shared through `.extend()` does, so both the same-instance and the
 * independently-declared cases are judged.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { embedding } from "../../src";
import { isStructuralSubtype } from "../../src/schema/structural-subtype";
import { structuralSubtypeProjection } from "../../src/schema/structural-subtype-projection";
import { propertyRuns } from "./run-budget";

// ============================================================
// Specs
// ============================================================

type StringCheck =
  | Readonly<{ check: "min" | "max" | "length"; value: number }>
  | Readonly<{ check: "regex"; source: string; flags: string }>
  | Readonly<{ check: "startsWith" | "endsWith" | "includes"; value: string }>
  | Readonly<{
      check: "lowercase" | "uppercase" | "trim" | "toLowerCase" | "toUpperCase";
    }>;

type NumberCheck = Readonly<{
  check: "min" | "max" | "gt" | "lt" | "multipleOf";
  value: number;
}>;

type ObjectMode = "strip" | "loose" | "strict" | "catchall";

type UnprojectableVariant =
  | "transform"
  | "transformMin3"
  | "transformUpper"
  | "date"
  | "dateMin"
  | "customString"
  | "customShortString"
  | "embedding2"
  | "embedding3"
  | "embedding2L2"
  | "bigint"
  | "int64"
  | "uint64";

type FallbackWrapper = "default" | "catch" | "prefault";
type PreprocessFunction = "trim" | "upper" | "identity";

type Spec =
  | Readonly<{
      kind: "string";
      base: "string" | "email" | "uuid" | "url";
      checks: readonly StringCheck[];
    }>
  | Readonly<{ kind: "number"; int: boolean; checks: readonly NumberCheck[] }>
  | Readonly<{ kind: "boolean" | "null" | "unknown" }>
  | Readonly<{ kind: "literal"; values: readonly (string | number)[] }>
  | Readonly<{ kind: "array"; item: Spec; min?: number; max?: number }>
  | Readonly<{ kind: "tuple"; items: readonly Spec[]; rest?: Spec }>
  | Readonly<{
      kind: "object";
      fields: readonly Readonly<{
        name: string;
        spec: Spec;
        optional: boolean;
      }>[];
      mode: ObjectMode;
      catchall?: Spec;
    }>
  | Readonly<{
      kind: "record";
      keys: readonly string[];
      partial: boolean;
      optionalValues: boolean;
      value: Spec;
    }>
  | Readonly<{
      kind: "fallback";
      wrapper: FallbackWrapper;
      value: string | number;
      inner: Spec;
    }>
  | Readonly<{ kind: "pipe"; from: Spec; to: Spec }>
  | Readonly<{ kind: "preprocess"; fn: PreprocessFunction; inner: Spec }>
  | Readonly<{ kind: "union"; members: readonly Spec[] }>
  | Readonly<{ kind: "nullable"; inner: Spec }>
  | Readonly<{
      kind: "unprojectable";
      variant: UnprojectableVariant;
      slot: number;
    }>;

const UNPROJECTABLE_VARIANTS: readonly UnprojectableVariant[] = [
  "transform",
  "transformMin3",
  "transformUpper",
  "date",
  "dateMin",
  "customString",
  "customShortString",
  "embedding2",
  "embedding3",
  "embedding2L2",
  "bigint",
  "int64",
  "uint64",
];

const STRING_POOL = [
  "",
  "a",
  "ab",
  "abc",
  "abcd",
  "ABC",
  "Ab",
  " a",
  " ab ",
  "ß",
  "é",
  "😀",
  "a😀",
  "1",
  "b",
  "ba",
  "x@y.co",
  "https://example.com",
  "http://e.io",
  "123e4567-e89b-42d3-a456-426614174000",
  "aaaaaa",
];

const NUMBER_POOL = [
  -5,
  -1,
  -0.5,
  0,
  0.1,
  0.25,
  0.3,
  1,
  1.5,
  2,
  3,
  4,
  5,
  6,
  10,
  0.1 + 0.2,
  1e21,
];

/**
 * Values no JSON row holds, for the nodes that admit them: dates (one of
 * them invalid) and bigints on both sides of the 64-bit ranges.
 */
const NATIVE_VALUE_POOL: readonly unknown[] = [
  new Date(0),
  new Date(-86_400_000),
  new Date(Number.NaN),
  new Date("2026-01-01T00:00:00.000Z"),
  -1n,
  0n,
  5n,
  2n ** 64n,
  -(2n ** 63n) - 1n,
];

const DATE_VALUES = NATIVE_VALUE_POOL.filter((value) => value instanceof Date);
const BIGINT_VALUES = NATIVE_VALUE_POOL.filter(
  (value) => typeof value === "bigint",
);

/** The Zod-native values each date and bigint variant is sampled with. */
const NATIVE_VALUES_BY_VARIANT: Readonly<
  Partial<Record<UnprojectableVariant, readonly unknown[]>>
> = {
  date: DATE_VALUES,
  dateMin: DATE_VALUES,
  bigint: BIGINT_VALUES,
  int64: BIGINT_VALUES,
  uint64: BIGINT_VALUES,
};

/** Variants that share a Zod node type, the near misses for one another. */
const SIBLING_VARIANTS: readonly (readonly UnprojectableVariant[])[] = [
  ["bigint", "int64", "uint64"],
  ["date", "dateMin"],
  ["transform", "transformMin3", "transformUpper"],
  ["customString", "customShortString"],
];

const KEY_POOL = ["a", "b", "c", "A", ""];

const PATTERN_POOL = ["^a", "b$", "^[a-c]+$", "^.{2}$", String.raw`\d`, "^.$"];

// ============================================================
// Building Zod schemas from specs
// ============================================================

function applyStringCheck(
  schema: z.ZodString,
  check: StringCheck,
): z.ZodString {
  switch (check.check) {
    case "min": {
      return schema.min(check.value);
    }
    case "max": {
      return schema.max(check.value);
    }
    case "length": {
      return schema.length(check.value);
    }
    case "regex": {
      return schema.regex(new RegExp(check.source, check.flags));
    }
    case "startsWith": {
      return schema.startsWith(check.value);
    }
    case "endsWith": {
      return schema.endsWith(check.value);
    }
    case "includes": {
      return schema.includes(check.value);
    }
    case "lowercase": {
      return schema.lowercase();
    }
    case "uppercase": {
      return schema.uppercase();
    }
    case "trim": {
      return schema.trim();
    }
    case "toLowerCase": {
      return schema.toLowerCase();
    }
    case "toUpperCase": {
      return schema.toUpperCase();
    }
  }
}

function stringBase(base: Extract<Spec, { kind: "string" }>["base"]) {
  switch (base) {
    case "string": {
      return z.string();
    }
    case "email": {
      return z.email();
    }
    case "uuid": {
      return z.uuid();
    }
    case "url": {
      return z.url();
    }
  }
}

function applyNumberCheck(
  schema: z.ZodNumber,
  check: NumberCheck,
): z.ZodNumber {
  switch (check.check) {
    case "min": {
      return schema.min(check.value);
    }
    case "max": {
      return schema.max(check.value);
    }
    case "gt": {
      return schema.gt(check.value);
    }
    case "lt": {
      return schema.lt(check.value);
    }
    case "multipleOf": {
      return schema.multipleOf(check.value);
    }
  }
}

function identity(value: string): string {
  return value;
}

function upper(value: string): string {
  return value.toUpperCase();
}

function buildUnprojectable(variant: UnprojectableVariant): z.ZodType {
  switch (variant) {
    case "transform": {
      return z.string().transform((value) => identity(value));
    }
    case "transformMin3": {
      return z
        .string()
        .min(3)
        .transform((value) => identity(value));
    }
    case "transformUpper": {
      return z.string().transform((value) => upper(value));
    }
    case "date": {
      return z.date();
    }
    case "dateMin": {
      return z.date().min(new Date(0));
    }
    case "bigint": {
      return z.bigint();
    }
    case "int64": {
      return z.int64();
    }
    case "uint64": {
      return z.uint64();
    }
    case "customString": {
      return z.custom<string>((value) => typeof value === "string");
    }
    case "customShortString": {
      return z.custom<string>(
        (value) => typeof value === "string" && value.length < 2,
      );
    }
    case "embedding2": {
      return embedding(2);
    }
    case "embedding3": {
      return embedding(3);
    }
    case "embedding2L2": {
      return embedding(2, { metric: "l2" });
    }
  }
}

/**
 * One Zod instance per unconvertible variant and slot, shared by both sides
 * of the pair being built.
 */
type InstanceCache = Map<string, z.ZodType>;

function sharedUnprojectable(
  spec: Extract<Spec, { kind: "unprojectable" }>,
  cache: InstanceCache,
): z.ZodType {
  const key = `${spec.variant}:${spec.slot}`;
  const existing = cache.get(key);
  if (existing !== undefined) return existing;
  const built = buildUnprojectable(spec.variant);
  cache.set(key, built);
  return built;
}

function buildFallback(
  spec: Extract<Spec, { kind: "fallback" }>,
  inner: z.ZodType,
): z.ZodType {
  switch (spec.wrapper) {
    case "default": {
      return inner.default(spec.value as never);
    }
    case "catch": {
      return inner.catch(spec.value as never);
    }
    case "prefault": {
      return inner.prefault(spec.value as never);
    }
  }
}

function preprocessValue(fn: PreprocessFunction, value: unknown): unknown {
  if (typeof value !== "string") return value;
  switch (fn) {
    case "trim": {
      return value.trim();
    }
    case "upper": {
      return value.toUpperCase();
    }
    case "identity": {
      return value;
    }
  }
}

function buildObject(
  spec: Extract<Spec, { kind: "object" }>,
  cache: InstanceCache,
): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  for (const field of spec.fields) {
    const built = build(field.spec, cache);
    shape[field.name] = field.optional ? built.optional() : built;
  }
  switch (spec.mode) {
    case "strip": {
      return z.object(shape);
    }
    case "loose": {
      return z.looseObject(shape);
    }
    case "strict": {
      return z.strictObject(shape);
    }
    case "catchall": {
      return z
        .object(shape)
        .catchall(build(spec.catchall ?? { kind: "unknown" }, cache));
    }
  }
}

function build(spec: Spec, cache: InstanceCache): z.ZodType {
  switch (spec.kind) {
    case "string": {
      let schema = stringBase(spec.base) as z.ZodString;
      for (const check of spec.checks) schema = applyStringCheck(schema, check);
      return schema;
    }
    case "number": {
      let schema: z.ZodNumber = spec.int ? z.int() : z.number();
      for (const check of spec.checks) schema = applyNumberCheck(schema, check);
      return schema;
    }
    case "boolean": {
      return z.boolean();
    }
    case "null": {
      return z.null();
    }
    case "unknown": {
      return z.unknown();
    }
    case "literal": {
      return z.literal(spec.values);
    }
    case "array": {
      const array = z.array(build(spec.item, cache));
      const withMin = spec.min === undefined ? array : array.min(spec.min);
      return spec.max === undefined ? withMin : withMin.max(spec.max);
    }
    case "tuple": {
      const items = spec.items.map((item) => build(item, cache)) as [
        z.ZodType,
        ...z.ZodType[],
      ];
      return spec.rest === undefined ?
          z.tuple(items)
        : z.tuple(items, build(spec.rest, cache));
    }
    case "object": {
      return buildObject(spec, cache);
    }
    case "record": {
      const keys = z.enum(spec.keys as [string, ...string[]]);
      const built = build(spec.value, cache);
      const value = spec.optionalValues ? built.optional() : built;
      return spec.partial ?
          z.partialRecord(keys, value)
        : z.record(keys, value);
    }
    case "fallback": {
      return buildFallback(spec, build(spec.inner, cache));
    }
    case "pipe": {
      return build(spec.from, cache).pipe(build(spec.to, cache));
    }
    case "preprocess": {
      return z.preprocess(
        (value) => preprocessValue(spec.fn, value),
        build(spec.inner, cache),
      );
    }
    case "union": {
      return z.union(
        spec.members.map((member) => build(member, cache)) as [
          z.ZodType,
          z.ZodType,
          ...z.ZodType[],
        ],
      );
    }
    case "nullable": {
      return build(spec.inner, cache).nullable();
    }
    case "unprojectable": {
      return sharedUnprojectable(spec, cache);
    }
  }
}

// ============================================================
// Spec arbitraries
// ============================================================

const stringCheckArb: fc.Arbitrary<StringCheck> = fc.oneof(
  fc.record({
    check: fc.constantFrom("min", "max", "length"),
    value: fc.nat({ max: 4 }),
  }),
  fc.record({
    check: fc.constant("regex"),
    source: fc.constantFrom(...PATTERN_POOL),
    flags: fc.constantFrom("", "", "i", "u", "g"),
  }),
  fc.record({
    check: fc.constantFrom("startsWith", "endsWith", "includes"),
    value: fc.constantFrom("a", "b", "A"),
  }),
  fc.record({
    check: fc.constantFrom(
      "lowercase",
      "uppercase",
      "trim",
      "toLowerCase",
      "toUpperCase",
    ),
  }),
);

/** At most one pattern-bearing check: two project as `allOf`, refused outright. */
function hasAtMostOnePattern(checks: readonly StringCheck[]): boolean {
  const patternChecks = new Set([
    "regex",
    "startsWith",
    "endsWith",
    "includes",
    "lowercase",
    "uppercase",
  ]);
  return checks.filter((check) => patternChecks.has(check.check)).length <= 1;
}

const stringSpecArb: fc.Arbitrary<Spec> = fc.record({
  kind: fc.constant("string"),
  base: fc.constantFrom("string", "string", "string", "email", "uuid", "url"),
  checks: fc
    .array(stringCheckArb, { maxLength: 3 })
    .filter((checks) => hasAtMostOnePattern(checks)),
});

const numberCheckArb: fc.Arbitrary<NumberCheck> = fc.oneof(
  fc.record({
    check: fc.constantFrom("min", "max", "gt", "lt"),
    value: fc.integer({ min: -2, max: 5 }),
  }),
  fc.record({
    check: fc.constant("multipleOf"),
    value: fc.constantFrom(2, 3, 0.1, 0.25),
  }),
);

const numberSpecArb: fc.Arbitrary<Spec> = fc.record({
  kind: fc.constant("number"),
  int: fc.boolean(),
  checks: fc
    .array(numberCheckArb, { maxLength: 3 })
    .filter(
      (checks) =>
        checks.filter((check) => check.check === "multipleOf").length <= 1,
    ),
});

const literalSpecArb: fc.Arbitrary<Spec> = fc.record({
  kind: fc.constant("literal"),
  values: fc.uniqueArray(
    fc.oneof(fc.constantFrom(...STRING_POOL), fc.constantFrom(...NUMBER_POOL)),
    { minLength: 1, maxLength: 3 },
  ),
});

const leafSpecArb: fc.Arbitrary<Spec> = fc.oneof(
  { weight: 4, arbitrary: stringSpecArb },
  { weight: 3, arbitrary: numberSpecArb },
  { weight: 2, arbitrary: literalSpecArb },
  {
    weight: 1,
    arbitrary: fc.constantFrom<Spec>(
      { kind: "boolean" },
      { kind: "null" },
      { kind: "unknown" },
    ),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("unprojectable"),
      variant: fc.constantFrom(...UNPROJECTABLE_VARIANTS),
      slot: fc.nat({ max: 1 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom(2, 3).chain((length) => fixedArrayArb(length)),
  },
);

/** The dimension count of each `embedding()` variant. */
const EMBEDDING_DIMENSIONS: Readonly<
  Partial<Record<UnprojectableVariant, number>>
> = { embedding2: 2, embedding3: 3, embedding2L2: 2 };

const embeddingSpecArb: fc.Arbitrary<Spec> = fc.record({
  kind: fc.constant("unprojectable"),
  variant: fc.constantFrom<UnprojectableVariant>(
    "embedding2",
    "embedding3",
    "embedding2L2",
  ),
  slot: fc.nat({ max: 1 }),
});

/**
 * An array of `length` numbers, bounded numbers or strings, around an
 * `embedding()`'s length: the plain arrays an embedding is compared with
 * in both directions.
 */
function fixedArrayArb(length: number): fc.Arbitrary<Spec> {
  return fc.record({
    kind: fc.constant("array"),
    item: fc.oneof(numberSpecArb, stringSpecArb),
    min: fc.constantFrom(length - 1, length),
    max: fc.constantFrom(length, length + 1),
  });
}

const fallbackValueArb: fc.Arbitrary<string | number> = fc.oneof(
  fc.constantFrom(...STRING_POOL),
  fc.constantFrom(...NUMBER_POOL),
);

const FIELD_NAMES = ["f", "g", "h"] as const;

const specLetrec = fc.letrec<{ spec: Spec; container: Spec }>((tie) => ({
  spec: fc.oneof(
    { maxDepth: 2, depthIdentifier: "spec" },
    { weight: 3, arbitrary: leafSpecArb },
    { weight: 2, arbitrary: tie("container") },
  ),
  container: fc.oneof(
    fc.record(
      {
        kind: fc.constant("array"),
        item: tie("spec"),
        min: fc.nat({ max: 2 }),
        max: fc.integer({ min: 1, max: 4 }),
      },
      { requiredKeys: ["kind", "item"] },
    ),
    fc.record(
      {
        kind: fc.constant("tuple"),
        items: fc.array(tie("spec"), { minLength: 1, maxLength: 2 }),
        rest: tie("spec"),
      },
      { requiredKeys: ["kind", "items"] },
    ),
    fc.record(
      {
        kind: fc.constant("object"),
        fields: fc.uniqueArray(
          fc.record({
            name: fc.constantFrom(...FIELD_NAMES),
            spec: tie("spec"),
            optional: fc.boolean(),
          }),
          { selector: (field) => field.name, maxLength: 2 },
        ),
        mode: fc.constantFrom<ObjectMode>(
          "strip",
          "loose",
          "strict",
          "catchall",
        ),
        catchall: tie("spec"),
      },
      { requiredKeys: ["kind", "fields", "mode"] },
    ),
    fc.record({
      kind: fc.constant("record"),
      keys: fc.uniqueArray(fc.constantFrom(...KEY_POOL), {
        minLength: 1,
        maxLength: 3,
      }),
      partial: fc.boolean(),
      optionalValues: fc.boolean(),
      value: tie("spec"),
    }),
    fc.record({
      kind: fc.constant("fallback"),
      wrapper: fc.constantFrom<FallbackWrapper>("default", "catch", "prefault"),
      value: fallbackValueArb,
      inner: tie("spec"),
    }),
    fc.record({
      kind: fc.constant("pipe"),
      from: tie("spec"),
      to: tie("spec"),
    }),
    fc.record({
      kind: fc.constant("preprocess"),
      fn: fc.constantFrom<PreprocessFunction>("trim", "upper", "identity"),
      inner: tie("spec"),
    }),
    fc.record({
      kind: fc.constant("union"),
      members: fc.array(tie("spec"), { minLength: 2, maxLength: 2 }),
    }),
    fc.record({ kind: fc.constant("nullable"), inner: tie("spec") }),
  ),
}));

const specArb: fc.Arbitrary<Spec> = specLetrec.spec;

// ============================================================
// Near-miss children
// ============================================================

function replaceAt<T>(items: readonly T[], index: number, item: T): T[] {
  return items.map((existing, position) =>
    position === index ? item : existing,
  );
}

/** `spec` with one random edit applied somewhere in its tree. */
function editArb(spec: Spec): fc.Arbitrary<Spec> {
  const local: fc.Arbitrary<Spec>[] = [
    specArb,
    fc.constant<Spec>({ kind: "nullable", inner: spec }),
    fc.record({
      kind: fc.constant("fallback"),
      wrapper: fc.constantFrom<FallbackWrapper>("default", "catch", "prefault"),
      value: fallbackValueArb,
      inner: fc.constant(spec),
    }),
    fc.record({
      kind: fc.constant("preprocess"),
      fn: fc.constantFrom<PreprocessFunction>("trim", "upper", "identity"),
      inner: fc.constant(spec),
    }),
    specArb.map((from): Spec => ({ kind: "pipe", from, to: spec })),
    fc.constant<Spec>({ kind: "pipe", from: { kind: "unknown" }, to: spec }),
  ];
  switch (spec.kind) {
    case "string": {
      local.push(
        fc
          .tuple(stringCheckArb, fc.nat({ max: spec.checks.length }))
          .map(([check, at]) => ({
            ...spec,
            checks: [
              ...spec.checks.slice(0, at),
              check,
              ...spec.checks.slice(at),
            ],
          }))
          .filter((edited) => hasAtMostOnePattern(edited.checks)),
      );
      if (spec.checks.length > 0) {
        local.push(
          fc.nat({ max: spec.checks.length - 1 }).map((at) => ({
            ...spec,
            checks: spec.checks.filter((_check, index) => index !== at),
          })),
        );
      }
      break;
    }
    case "number": {
      local.push(
        numberCheckArb.map((check) => ({
          ...spec,
          checks: [...spec.checks, check],
        })),
        fc.constant({ ...spec, int: !spec.int }),
      );
      if (spec.checks.length > 0) {
        local.push(
          fc.nat({ max: spec.checks.length - 1 }).map((at) => ({
            ...spec,
            checks: spec.checks.filter((_check, index) => index !== at),
          })),
        );
      }
      break;
    }
    case "array": {
      local.push(
        embeddingSpecArb,
        editArb(spec.item).map((item) => ({ ...spec, item })),
        fc.record({ min: fc.nat({ max: 3 }) }).map(({ min }) => ({
          ...spec,
          min,
        })),
      );
      break;
    }
    case "tuple": {
      local.push(
        fc.nat({ max: spec.items.length - 1 }).chain((at) =>
          editArb(spec.items[at] ?? { kind: "unknown" }).map((item) => ({
            ...spec,
            items: replaceAt(spec.items, at, item),
          })),
        ),
        fc.constant({ kind: "array", item: spec.items[0] ?? spec }),
      );
      break;
    }
    case "object": {
      local.push(
        fc
          .constantFrom<ObjectMode>("strip", "loose", "strict", "catchall")
          .map((mode) => ({ ...spec, mode })),
      );
      if (spec.fields.length > 0) {
        local.push(
          fc.nat({ max: spec.fields.length - 1 }).chain((at) => {
            const field = spec.fields[at];
            if (field === undefined) return fc.constant(spec);
            return fc.oneof(
              editArb(field.spec).map((edited) => ({
                ...spec,
                fields: replaceAt(spec.fields, at, { ...field, spec: edited }),
              })),
              fc.constant({
                ...spec,
                fields: replaceAt(spec.fields, at, {
                  ...field,
                  optional: !field.optional,
                }),
              }),
              fc.constant({
                ...spec,
                fields: spec.fields.filter((_field, index) => index !== at),
              }),
            );
          }),
        );
      }
      break;
    }
    case "record": {
      local.push(
        editArb(spec.value).map((value) => ({ ...spec, value })),
        fc.constant({ ...spec, partial: !spec.partial }),
        fc.constant({ ...spec, optionalValues: !spec.optionalValues }),
        fc.constant({ ...spec, keys: spec.keys.slice(0, 1) }),
      );
      break;
    }
    case "union": {
      local.push(
        fc.nat({ max: spec.members.length - 1 }).chain((at) =>
          editArb(spec.members[at] ?? { kind: "unknown" }).map((member) => ({
            ...spec,
            members: replaceAt(spec.members, at, member),
          })),
        ),
        fc.constant(spec.members[0] ?? spec),
      );
      break;
    }
    case "nullable": {
      local.push(
        fc.constant(spec.inner),
        editArb(spec.inner).map((inner) => ({ ...spec, inner })),
      );
      break;
    }
    case "unprojectable": {
      local.push(
        fc
          .constantFrom(...UNPROJECTABLE_VARIANTS)
          .map((variant) => ({ ...spec, variant })),
        fc.constant({ ...spec, slot: 1 - spec.slot }),
      );
      const siblings = SIBLING_VARIANTS.find((family) =>
        family.includes(spec.variant),
      );
      if (siblings !== undefined) {
        local.push(
          fc.constantFrom(...siblings).map((variant) => ({ ...spec, variant })),
        );
      }
      const dimensions = EMBEDDING_DIMENSIONS[spec.variant];
      if (dimensions !== undefined) local.push(fixedArrayArb(dimensions));
      break;
    }
    case "fallback":
    case "preprocess": {
      local.push(
        fc.constant(spec.inner),
        editArb(spec.inner).map((inner) => ({ ...spec, inner })),
      );
      break;
    }
    case "pipe": {
      local.push(
        fc.constant(spec.to),
        fc.constant(spec.from),
        editArb(spec.from).map((from) => ({ ...spec, from })),
      );
      break;
    }
    case "boolean":
    case "null":
    case "unknown":
    case "literal": {
      break;
    }
  }
  return fc.oneof(...local);
}

const pairArb: fc.Arbitrary<Readonly<{ child: Spec; parent: Spec }>> =
  specArb.chain((parent) =>
    fc
      .oneof(
        { weight: 6, arbitrary: editArb(parent) },
        {
          weight: 3,
          arbitrary: editArb(parent).chain((edited) => editArb(edited)),
        },
        { weight: 1, arbitrary: specArb },
      )
      .map((child) => ({ child, parent })),
  );

// ============================================================
// Candidate values a child may store
// ============================================================

const scalarPoolArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom(...STRING_POOL),
  fc.constantFrom(...NUMBER_POOL),
  // eslint-disable-next-line unicorn/no-null -- JSON null is a stored value
  fc.constantFrom<unknown>(true, false, null),
);

/** JSON values shaped roughly like `spec`, plus pool noise. */
function candidateArb(spec: Spec): fc.Arbitrary<unknown> {
  return fc.oneof(
    { weight: 1, arbitrary: scalarPoolArb },
    { weight: 4, arbitrary: shapedCandidateArb(spec) },
  );
}

function shapedCandidateArb(spec: Spec): fc.Arbitrary<unknown> {
  switch (spec.kind) {
    case "string": {
      return fc.constantFrom(...STRING_POOL);
    }
    case "unprojectable": {
      const native = NATIVE_VALUES_BY_VARIANT[spec.variant];
      if (native !== undefined) {
        return fc.oneof(
          { weight: 4, arbitrary: fc.constantFrom(...native) },
          { weight: 1, arbitrary: scalarPoolArb },
        );
      }
      return fc.oneof(
        fc.constantFrom(...STRING_POOL),
        fc.array(fc.constantFrom(...NUMBER_POOL), {
          minLength: 2,
          maxLength: 3,
        }),
        fc.constantFrom(...NATIVE_VALUE_POOL),
      );
    }
    case "fallback":
    case "preprocess": {
      return fc.oneof(
        fc.constant(undefined),
        fc.constantFrom(...STRING_POOL),
        candidateArb(spec.inner),
      );
    }
    case "pipe": {
      return candidateArb(spec.from);
    }
    case "number": {
      return fc.constantFrom(...NUMBER_POOL);
    }
    case "literal": {
      return fc.constantFrom(...spec.values);
    }
    case "array": {
      return fc.oneof(
        fc.array(candidateArb(spec.item), { maxLength: 5 }),
        // Lengths the bounds admit, where a near-miss bound shows up.
        fc.array(candidateArb(spec.item), {
          minLength: spec.min ?? 0,
          maxLength: Math.max(spec.min ?? 0, spec.max ?? 5),
        }),
      );
    }
    case "tuple": {
      return fc
        .tuple(
          fc.tuple(...spec.items.map((item) => candidateArb(item))),
          fc.array(candidateArb(spec.rest ?? { kind: "unknown" }), {
            maxLength: 2,
          }),
        )
        .map(([prefix, rest]) => [...prefix, ...rest]);
    }
    case "object": {
      const fields: Record<string, fc.Arbitrary<unknown>> = {};
      for (const field of spec.fields) {
        fields[field.name] = candidateArb(field.spec);
      }
      return fc
        .tuple(
          fc.record(fields, { requiredKeys: [] }),
          fc.option(candidateArb(spec.catchall ?? { kind: "unknown" }), {
            nil: undefined,
          }),
        )
        .map(([declared, extra]) =>
          extra === undefined ? declared : { ...declared, extra },
        );
    }
    case "record": {
      return fc.dictionary(
        fc.constantFrom(...spec.keys, ...KEY_POOL),
        candidateArb(spec.value),
        { maxKeys: 4 },
      );
    }
    case "union": {
      return fc.oneof(...spec.members.map((member) => candidateArb(member)));
    }
    case "nullable": {
      // eslint-disable-next-line unicorn/no-null -- the value `.nullable()` adds
      return fc.oneof(fc.constant(null), candidateArb(spec.inner));
    }
    case "boolean":
    case "null":
    case "unknown": {
      return scalarPoolArb;
    }
  }
}

/**
 * `value` as an input reaches a node: JSON's reading of every plain value
 * (an absent `undefined` member, `null` for a missing array slot or a
 * non-finite number), with dates and bigints kept for the nodes that parse
 * them.
 */
function asInputValue(value: unknown): unknown {
  if (value instanceof Date || typeof value === "bigint") return value;
  if (typeof value === "number") {
    // eslint-disable-next-line unicorn/no-null -- JSON writes a non-finite number as null
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    // eslint-disable-next-line unicorn/no-null -- JSON writes a missing array slot as null
    return value.map((member) => asInputValue(member) ?? null);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, member]) => member !== undefined)
        .map(([key, member]) => [key, asInputValue(member)]),
    );
  }
  return value;
}

// ============================================================
// The property
// ============================================================

const pairWithSamplesArb = pairArb.chain((pair) =>
  fc
    .array(candidateArb(pair.child), { minLength: 4, maxLength: 12 })
    .map((samples) => ({ ...pair, samples })),
);

function expectSoundVerdict(
  child: Spec,
  parent: Spec,
  samples: readonly unknown[],
): void {
  const cache: InstanceCache = new Map();
  const childSchema = z.object({ field: build(child, cache) });
  const parentSchema = z.object({ field: build(parent, cache) });
  const verdict = isStructuralSubtype(
    structuralSubtypeProjection(childSchema),
    structuralSubtypeProjection(parentSchema),
  );
  if (verdict.verdict !== "subtype") return;
  for (const sample of samples) {
    const input = asInputValue({ field: sample });
    const stored = childSchema.safeParse(input);
    if (!stored.success) continue;
    // What a row holds is the stored output as storage reads it back.
    const row = asInputValue(stored.data);
    expect({
      child,
      parent,
      input,
      row,
      parentAccepts: parentSchema.safeParse(row).success,
    }).toMatchObject({ parentAccepts: true });
  }
}

/** An `embedding()` and a plain array near its length, in either order. */
const embeddingPairArb = embeddingSpecArb.chain((embeddingSpec) => {
  const dimensions =
    embeddingSpec.kind === "unprojectable" ?
      (EMBEDDING_DIMENSIONS[embeddingSpec.variant] ?? 2)
    : 2;
  return fc
    .record({
      array: fixedArrayArb(dimensions),
      embeddingIsChild: fc.boolean(),
    })
    .chain(({ array, embeddingIsChild }) => {
      const child = embeddingIsChild ? embeddingSpec : array;
      const parent = embeddingIsChild ? array : embeddingSpec;
      return fc
        .array(candidateArb(child), { minLength: 4, maxLength: 12 })
        .map((samples) => ({ child, parent, samples }));
    });
});

describe("structural subtyping soundness against Zod", () => {
  it("an accepted pair admits no stored child value the parent's Zod schema refuses", () => {
    fc.assert(
      fc.property(pairWithSamplesArb, ({ child, parent, samples }) => {
        expectSoundVerdict(child, parent, samples);
      }),
      { numRuns: propertyRuns({ ci: 3000, local: 5000 }) },
    );
  });

  it("an embedding and a plain array admit nothing the other refuses, in either direction", () => {
    fc.assert(
      fc.property(embeddingPairArb, ({ child, parent, samples }) => {
        expectSoundVerdict(child, parent, samples);
      }),
      { numRuns: propertyRuns({ ci: 1000, local: 2000 }) },
    );
  });
});
