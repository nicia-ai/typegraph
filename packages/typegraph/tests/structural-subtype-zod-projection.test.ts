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

import { defineGraph, defineNode, subClassOf } from "../src";
import { ConfigurationError } from "../src/errors";
import { buildKindRegistry } from "../src/registry/builders";
import { serializeSchemaProperties } from "../src/schema/serializer";
import {
  ZOD_ONLY_CONSTRAINT_KEYWORD,
  ZOD_ONLY_PARENT_CONSTRAINT_KEYWORD,
} from "../src/schema/structural-subtype";

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
