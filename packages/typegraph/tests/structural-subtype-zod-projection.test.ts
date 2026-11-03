/**
 * The registry's structural-subsumption check compares a live graph's kinds
 * through `structuralSubtypeProjection`, which marks the Zod constraints the
 * JSON Schema projection drops. Each refused pair below is one the bare
 * projection judged `subtype` while the child admits a value the parent
 * refuses; each accepted pair shows the marker does not refuse a pair it
 * cannot make unsound.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, embedding, subClassOf } from "../src";
import { ConfigurationError } from "../src/errors";
import { buildKindRegistry } from "../src/registry/builders";
import { serializeSchemaProperties } from "../src/schema/serializer";
import {
  isStructuralSubtype,
  type StructuralSubtypeResult,
  ZOD_ONLY_CONSTRAINT_KEYWORD,
  ZOD_ONLY_PARENT_CONSTRAINT_KEYWORD,
} from "../src/schema/structural-subtype";
import { structuralSubtypeProjection } from "../src/schema/structural-subtype-projection";

function subclassRegistryError(
  childSchema: z.ZodObject,
  parentSchema: z.ZodObject,
): unknown {
  const Child = defineNode("ProjectionChild", { schema: childSchema });
  const Parent = defineNode("ProjectionParent", { schema: parentSchema });
  try {
    buildKindRegistry(
      defineGraph({
        id: "structural_subtype_projection",
        nodes: {
          ProjectionChild: { type: Child },
          ProjectionParent: { type: Parent },
        },
        edges: {},
        ontology: [subClassOf(Child, Parent)],
      }),
    );
    return undefined;
  } catch (error) {
    return error;
  }
}

function expectIncomparable(error: unknown): void {
  expect(error).toBeInstanceOf(ConfigurationError);
  expect((error as ConfigurationError).details).toMatchObject({
    code: "ONTOLOGY_SUBCLASS_SCHEMA_INCOMPARABLE",
    reason: "unsupported-construct",
  });
}

describe("structural subsumption over constraints the JSON Schema projection drops", () => {
  it("refuses a case-insensitive pattern under a case-sensitive one", () => {
    const child = z.object({ code: z.string().regex(/^abc$/i) });
    const parent = z.object({ code: z.string().regex(/^abc$/) });
    expect(child.safeParse({ code: "ABC" }).success).toBe(true);
    expect(parent.safeParse({ code: "ABC" }).success).toBe(false);

    const error = subclassRegistryError(child, parent);

    expectIncomparable(error);
    expect((error as ConfigurationError).details).toMatchObject({
      path: ["code"],
    });
  });

  it("refuses a flagged pattern carried by a custom string format", () => {
    const child = z.object({ code: z.stringFormat("vx-code", /^abc$/i) });
    const parent = z.object({ code: z.stringFormat("vx-code", /^abc$/) });
    expect(child.safeParse({ code: "ABC" }).success).toBe(true);
    expect(parent.safeParse({ code: "ABC" }).success).toBe(false);

    expectIncomparable(subclassRegistryError(child, parent));
  });

  it("refuses a flagged pattern overriding a built-in string format", () => {
    const child = z.object({ mail: z.email({ pattern: /^[a-z]+@x\.y$/i }) });
    const parent = z.object({ mail: z.email({ pattern: /^[a-z]+@x\.y$/ }) });
    expect(child.safeParse({ mail: "ABC@x.y" }).success).toBe(true);
    expect(parent.safeParse({ mail: "ABC@x.y" }).success).toBe(false);

    expectIncomparable(subclassRegistryError(child, parent));
  });

  it("refuses a flagged pattern on the parent side too", () => {
    expectIncomparable(
      subclassRegistryError(
        z.object({ code: z.string().regex(/^abc$/) }),
        z.object({ code: z.string().regex(/^abc$/u) }),
      ),
    );
  });

  it("accepts the same flagged pattern on both sides, and a global-only flag", () => {
    expect(
      subclassRegistryError(
        z.object({ code: z.string().regex(/^abc$/i), extra: z.string() }),
        z.object({ code: z.string().regex(/^abc$/i) }),
      ),
    ).toBeUndefined();
    expect(
      subclassRegistryError(
        z.object({ code: z.string().regex(/^abc$/g).min(1) }),
        z.object({ code: z.string().regex(/^abc$/) }),
      ),
    ).toBeUndefined();
  });

  it("refuses a parent refinement the child is never compared with", () => {
    const child = z.object({ low: z.number(), high: z.number() });
    const parent = z
      .object({ low: z.number(), high: z.number() })
      .refine((value) => value.low <= value.high);
    expect(child.safeParse({ low: 2, high: 1 }).success).toBe(true);
    expect(parent.safeParse({ low: 2, high: 1 }).success).toBe(false);

    expectIncomparable(subclassRegistryError(child, parent));
  });

  it("accepts a refinement on the child, and a refined field schema both sides share", () => {
    const ordered = z.number().refine((value) => value >= 0);
    expect(
      subclassRegistryError(
        z.object({ count: z.number().refine((value) => value > 0) }),
        z.object({ count: z.number() }),
      ),
    ).toBeUndefined();
    expect(
      subclassRegistryError(
        z.object({ count: ordered, label: z.string() }),
        z.object({ count: ordered }),
      ),
    ).toBeUndefined();
  });

  it("refuses two different refinements that project identically", () => {
    expectIncomparable(
      subclassRegistryError(
        z.object({ count: z.number().refine((value) => value >= 0) }),
        z.object({ count: z.number().refine((value) => value > 10) }),
      ),
    );
  });

  it("refuses a child that adds a property under a strict parent", () => {
    const child = z.object({ name: z.string(), age: z.number() });
    const parent = z.strictObject({ name: z.string() });
    expect(parent.safeParse(child.parse({ name: "a", age: 1 })).success).toBe(
      false,
    );

    expectIncomparable(subclassRegistryError(child, parent));
    expect(
      subclassRegistryError(child, z.object({ name: z.string() })),
    ).toBeUndefined();
  });

  it("refuses a .meta() key spelled like a constraint", () => {
    const child = z.object({ code: z.string().meta({ maxLength: 2 }) });
    const parent = z.object({ code: z.string().max(2) });
    expect(child.safeParse({ code: "abcdef" }).success).toBe(true);
    expect(parent.safeParse({ code: "abcdef" }).success).toBe(false);

    expectIncomparable(subclassRegistryError(child, parent));
  });

  it("leaves the persisted projection free of comparison markers", () => {
    const projection = serializeSchemaProperties(
      z.strictObject({
        code: z.string().regex(/^abc$/i),
        count: z.number().refine((value) => value > 0),
      }),
    );

    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain(ZOD_ONLY_CONSTRAINT_KEYWORD);
    expect(serialized).not.toContain(ZOD_ONLY_PARENT_CONSTRAINT_KEYWORD);
  });
});

function liveVerdict(
  child: z.ZodType,
  parent: z.ZodType,
): StructuralSubtypeResult {
  return isStructuralSubtype(
    structuralSubtypeProjection(z.object({ field: child })),
    structuralSubtypeProjection(z.object({ field: parent })),
  );
}

describe("structural subsumption over formats, overwrites and literals the projection drops", () => {
  const refused: readonly {
    name: string;
    child: z.ZodType;
    parent: z.ZodType;
    witness: unknown;
  }[] = [
    {
      name: "z.literal(Infinity) under z.string().min(5)",
      child: z.literal(Number.POSITIVE_INFINITY),
      parent: z.string().min(5),
      witness: Number.POSITIVE_INFINITY,
    },
    {
      name: "z.literal(NaN) under z.boolean()",
      child: z.literal(Number.NaN),
      parent: z.boolean(),
      witness: Number.NaN,
    },
    {
      name: "z.literal(-Infinity) under z.null()",
      child: z.literal(Number.NEGATIVE_INFINITY),
      parent: z.null(),
      witness: Number.NEGATIVE_INFINITY,
    },
    {
      name: "z.literal(Infinity) under z.object({})",
      child: z.literal(Number.POSITIVE_INFINITY),
      parent: z.object({}),
      witness: Number.POSITIVE_INFINITY,
    },
    {
      name: "z.literal(-Infinity) under z.enum(['a']).or(z.boolean())",
      child: z.literal(Number.NEGATIVE_INFINITY),
      parent: z.enum(["a"]).or(z.boolean()),
      witness: Number.NEGATIVE_INFINITY,
    },
    {
      name: "z.literal(Infinity).nullable() under z.string().nullable()",
      child: z.literal(Number.POSITIVE_INFINITY).nullable(),
      parent: z.string().nullable(),
      witness: Number.POSITIVE_INFINITY,
    },
    {
      name: "z.literal([1, Infinity]) under z.int().max(5)",
      child: z.literal([1, Number.POSITIVE_INFINITY]),
      parent: z.int().max(5),
      witness: Number.POSITIVE_INFINITY,
    },
    {
      name: "z.literal([1, NaN]) under z.number().multipleOf(1)",
      child: z.literal([1, Number.NaN]),
      parent: z.number().multipleOf(1),
      witness: Number.NaN,
    },
    {
      name: "z.literal(NaN) under z.number()",
      child: z.literal(Number.NaN),
      parent: z.number(),
      witness: Number.NaN,
    },
    {
      name: "z.literal(['a', NaN]) under z.string().nullable()",
      child: z.literal(["a", Number.NaN]),
      parent: z.string().nullable(),
      witness: Number.NaN,
    },
    {
      name: "z.literal('https://') under z.url().startsWith('https://')",
      child: z.literal("https://"),
      parent: z.url().startsWith("https://"),
      witness: "https://",
    },
    {
      name: "z.string().startsWith('https://') under z.url().startsWith('https://')",
      child: z.string().startsWith("https://"),
      parent: z.url().startsWith("https://"),
      witness: "https://",
    },
    {
      name: "z.literal('abc') under z.url().lowercase()",
      child: z.literal("abc"),
      parent: z.url().lowercase(),
      witness: "abc",
    },
    {
      name: "z.literal('eyX') under z.jwt().startsWith('ey')",
      child: z.literal("eyX"),
      parent: z.jwt().startsWith("ey"),
      witness: "eyX",
    },
    {
      name: "z.literal('ABC') under z.httpUrl().uppercase()",
      child: z.literal("ABC"),
      parent: z.httpUrl().uppercase(),
      witness: "ABC",
    },
    {
      name: "z.literal('x') under z.string().url().endsWith('x')",
      child: z.literal("x"),
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- the format then arrives as a check, not on the schema
      parent: z.string().url().endsWith("x"),
      witness: "x",
    },
    {
      name: "z.literal('a') under z.stringFormat(fn).includes('a')",
      child: z.literal("a"),
      parent: z
        .stringFormat("even-length", (value) => value.length % 2 === 0)
        .includes("a"),
      witness: "a",
    },
    {
      name: "z.literal(' a') under z.string().trim().min(2)",
      child: z.literal(" a"),
      parent: z.string().trim().min(2),
      witness: " a",
    },
    {
      name: "z.string().min(2) under z.string().trim().min(2)",
      child: z.string().min(2),
      parent: z.string().trim().min(2),
      witness: " a",
    },
    {
      name: "z.literal(' ab') under z.string().trim().length(3)",
      child: z.literal(" ab"),
      parent: z.string().trim().length(3),
      witness: " ab",
    },
    {
      name: "z.literal('abc') under z.string().toUpperCase().regex(/^[a-z]+$/)",
      child: z.literal("abc"),
      parent: z
        .string()
        .toUpperCase()
        .regex(/^[a-z]+$/),
      witness: "abc",
    },
    {
      name: "z.literal('A') under z.string().toLowerCase().regex(/^A$/)",
      child: z.literal("A"),
      parent: z.string().toLowerCase().regex(/^A$/),
      witness: "A",
    },
    {
      name: "z.literal(U+0958) under z.string().normalize().max(1) (NFC decomposes it into two units)",
      child: z.literal("\u0958"),
      parent: z.string().normalize().max(1),
      witness: "\u0958",
    },
    {
      name: "z.string().min(2).trim() under z.string().min(2) (the child stores what min(2) never saw)",
      child: z.string().min(2).trim(),
      parent: z.string().min(2),
      witness: " a",
    },
    {
      name: "z.string().min(2).trim().max(5) under z.string().min(2).max(5) (an overwrite between two stated checks)",
      child: z.string().min(2).trim().max(5),
      parent: z.string().min(2).max(5),
      witness: " a",
    },
    {
      name: "z.literal(' a') under z.string().max(5).trim().min(2) (a check after the parent's interleaved overwrite)",
      child: z.literal(" a"),
      parent: z.string().max(5).trim().min(2),
      witness: " a",
    },
    {
      name: "record z.enum([' a']) keys under z.string().trim().min(2) keys",
      child: z.record(z.enum([" a"]), z.number()),
      parent: z.record(z.string().trim().min(2), z.number()),
      witness: { " a": 1 },
    },
    {
      name: "record z.enum(['abc']) keys under z.url().lowercase() keys",
      child: z.record(z.enum(["abc"]), z.number()),
      parent: z.record(z.url().lowercase(), z.number()),
      witness: { abc: 1 },
    },
  ];

  it.each(refused.map((row) => [row.name, row] as const))(
    "refuses %s",
    (_name, row) => {
      const stored = row.child.safeParse(row.witness);
      expect(stored.success).toBe(true);
      expect(row.parent.safeParse(stored.data).success).toBe(false);
      expect(liveVerdict(row.child, row.parent).verdict).not.toBe("subtype");
    },
  );

  it("still accepts an overwrite that cannot make the pair unsound", () => {
    expect(liveVerdict(z.string().trim(), z.string())).toEqual({
      verdict: "subtype",
    });
    expect(liveVerdict(z.string(), z.string().trim())).toEqual({
      verdict: "subtype",
    });
    expect(liveVerdict(z.string().min(2), z.string().min(2).trim())).toEqual({
      verdict: "incomparable",
      reason: "unsupported-construct",
      path: ["field"],
    });
    expect(liveVerdict(z.string().trim().min(3), z.string().min(2))).toEqual({
      verdict: "subtype",
    });
    const shared = z.string().trim().min(2);
    expect(liveVerdict(shared, shared)).toEqual({ verdict: "subtype" });
  });

  it("judges a finite union member on its own beside an unprojectable one", () => {
    // The `z.date()` member matches the parent's own `z.date()` member; the
    // literal member answers exactly as a bounded string would.
    const parent = z.union([z.date(), z.string().min(1)]);
    expect(liveVerdict(z.union([z.date(), z.literal("x")]), parent)).toEqual({
      verdict: "subtype",
    });
    expect(
      liveVerdict(z.union([z.date(), z.literal("")]), parent).verdict,
    ).not.toBe("subtype");
    // Under a parent with no unconvertible member, the `z.date()` member
    // matches nothing that can be judged.
    expect(
      liveVerdict(z.union([z.date(), z.literal("x")]), z.string().min(1)),
    ).toMatchObject({
      verdict: "incomparable",
      reason: "unsupported-construct",
    });
  });

  it("still accepts a single format under a bare string, and a pattern-stated format alone", () => {
    expect(liveVerdict(z.url(), z.string())).toEqual({ verdict: "subtype" });
    expect(
      liveVerdict(
        z.url().startsWith("https://"),
        z.string().startsWith("https://"),
      ),
    ).toEqual({ verdict: "subtype" });
    expect(liveVerdict(z.literal("ab"), z.string().startsWith("a"))).toEqual({
      verdict: "subtype",
    });
  });
});

function upper(value: string): string {
  return value.toUpperCase();
}

describe("structural subsumption over a field the projection cannot convert", () => {
  const sharedTransform = z.string().transform((value) => upper(value));

  // The unconvertible side states nothing, so nothing shows it narrows a
  // parent that constrains values, or satisfies a parent it stands for.
  const refused: readonly Readonly<{
    name: string;
    child: () => z.ZodType;
    parent: () => z.ZodType;
    path?: readonly string[];
  }>[] = [
    {
      name: "a transformed child under a bounded string",
      child: () => z.string().transform((value) => upper(value)),
      parent: () => z.string().min(3),
    },
    {
      name: "a plain child under a parent whose transform hides its bound",
      child: () => z.string(),
      parent: () =>
        z
          .string()
          .min(3)
          .transform((value) => upper(value)),
    },
    {
      name: "a custom child under a bounded number",
      child: () => z.custom<number>(),
      parent: () => z.number().min(5),
    },
    {
      name: "a date child under a bare string, which constrains by type",
      child: () => z.date(),
      parent: () => z.string(),
    },
    {
      name: "a bigint child under a bare number",
      child: () => z.bigint(),
      parent: () => z.number(),
    },
    {
      name: "a date child under an empty object",
      child: () => z.date(),
      parent: () => z.object({}),
    },
    {
      name: "a date child under a refined parent that projects as {}",
      child: () => z.date(),
      parent: () => z.unknown().refine((value) => value !== undefined),
    },
    {
      name: "an unknown child under a date parent",
      child: () => z.unknown(),
      parent: () => z.date(),
    },
    {
      name: "a date child under a custom parent, a different node type",
      child: () => z.date(),
      parent: () => z.custom<Date>(),
    },
    {
      name: "a date child under a nullable string",
      child: () => z.date(),
      parent: () => z.string().nullable(),
    },
    {
      name: "a nullable date child under a date parent",
      child: () => z.date().nullable(),
      parent: () => z.date(),
      path: ["field", "anyOf[1]"],
    },
    {
      name: "two independently declared transforms with different checks",
      child: () => z.string().transform((value) => upper(value)),
      parent: () =>
        z
          .string()
          .min(3)
          .transform((value) => upper(value)),
    },
    {
      name: "two independently declared identical transforms",
      child: () => z.string().transform((value) => upper(value)),
      parent: () => z.string().transform((value) => upper(value)),
    },
    {
      name: "embeddings of different dimensions",
      child: () => embedding(3),
      parent: () => embedding(4),
    },
    {
      name: "embeddings of different metrics",
      child: () => embedding(3, { metric: "l2" }),
      parent: () => embedding(3),
    },
    {
      name: "a bounded date under a plain one",
      child: () => z.date(),
      parent: () => z.date().min(new Date(0)),
    },
    {
      name: "a refined date under a plain one",
      child: () => z.date().refine((value) => value.getTime() > 0),
      parent: () => z.date(),
    },
    {
      name: "two independently declared custom checks",
      child: () => z.custom<string>((value) => typeof value === "string"),
      parent: () => z.custom<string>((value) => typeof value === "string"),
    },
    {
      name: "two independently declared sets",
      child: () => z.set(z.number()),
      parent: () => z.set(z.string()),
    },
    {
      name: "a defaulted transform under the transform it wraps",
      child: () => sharedTransform.default("x"),
      parent: () => sharedTransform,
    },
  ];

  it.each(refused)(
    "refuses $name as incomparable",
    ({ child, parent, path }) => {
      expect(liveVerdict(child(), parent())).toEqual({
        verdict: "incomparable",
        reason: "unsupported-construct",
        path: path ?? ["field"],
      });
    },
  );

  const accepted: readonly Readonly<{
    name: string;
    child: () => z.ZodType;
    parent: () => z.ZodType;
  }>[] = [
    {
      name: "a transformed child under z.unknown()",
      child: () => z.string().transform((value) => upper(value)),
      parent: () => z.unknown(),
    },
    {
      name: "a date child under z.any() carrying only a description",
      child: () => z.date(),
      parent: () => z.any().describe("anything"),
    },
    {
      name: "independently declared dates",
      child: () => z.date(),
      parent: () => z.date(),
    },
    {
      name: "a described date under a plain one",
      child: () => z.date().describe("when"),
      parent: () => z.date().readonly(),
    },
    {
      name: "a date child under a nullable date parent",
      child: () => z.date(),
      parent: () => z.date().nullable(),
    },
    {
      name: "plain bigints",
      child: () => z.bigint(),
      parent: () => z.bigint(),
    },
    {
      name: "a transform both sides share, as `.extend()` does",
      child: () => sharedTransform,
      parent: () => sharedTransform,
    },
    {
      name: "an optional wrapper around a shared transform",
      child: () => sharedTransform,
      parent: () => sharedTransform.optional(),
    },
    {
      name: "a separately redeclared embedding of equal dimensions",
      child: () => embedding(384),
      parent: () => embedding(384),
    },
  ];

  it.each(accepted)("accepts $name", ({ child, parent }) => {
    expect(liveVerdict(child(), parent())).toEqual({ verdict: "subtype" });
  });
});
