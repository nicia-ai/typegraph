import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { createLocalSqliteStore } from "../src/backend/sqlite/local-store";

const base = { name: z.string() };

/**
 * Schemas a kind cannot store: they have no object shape to validate, store
 * or introspect. Each crashed `defineNode` / `defineEdge` with a raw
 * `TypeError` before the typed refusal.
 */
const NOT_OBJECT_SCHEMAS = [
  [
    "union",
    "union",
    z.union([z.object(base), z.object({ title: z.string() })]),
  ],
  [
    "discriminatedUnion",
    "union",
    z.discriminatedUnion("variant", [
      z.object({ variant: z.literal("a"), name: z.string() }),
      z.object({ variant: z.literal("b") }),
    ]),
  ],
  [
    "intersection",
    "intersection",
    z.object(base).and(z.object({ n: z.number() })),
  ],
  ["record", "record", z.record(z.string(), z.string())],
  ["transform", "pipe", z.object(base).transform((value) => value)],
  ["pipe", "pipe", z.object(base).pipe(z.object(base))],
  ["optional object", "optional", z.object(base).optional()],
  ["readonly object", "readonly", z.object(base).readonly()],
  ["lazy object", "lazy", z.lazy(() => z.object(base))],
  ["string", "string", z.string()],
] as const;

/** Object schemas wrapped or built in ways that stay objects, and work. */
const OBJECT_SCHEMAS = [
  ["object", z.object(base)],
  ["strictObject", z.strictObject(base)],
  ["looseObject", z.looseObject(base)],
  ["refine", z.object(base).refine((value) => value.name.length > 0)],
  [
    "superRefine",
    z.object(base).superRefine((value, refinement) => {
      if (value.name.length === 0) {
        refinement.addIssue({ code: "custom", message: "empty" });
      }
    }),
  ],
  ["extend", z.object(base).extend({ n: z.number().optional() })],
] as const;

function refusalOf(build: () => unknown): ConfigurationError {
  try {
    build();
  } catch (error) {
    if (error instanceof ConfigurationError) return error;
    throw error;
  }
  throw new Error("expected the schema to be refused");
}

describe("kind schemas must be Zod objects", () => {
  it.each(NOT_OBJECT_SCHEMAS)(
    "defineNode refuses a %s schema with a typed error",
    (_label, schemaType, schema) => {
      const refusal = refusalOf(() =>
        defineNode("Shape", { schema: schema as never }),
      );
      expect(refusal.details).toEqual({
        code: "NODE_SCHEMA_NOT_OBJECT",
        nodeType: "Shape",
        schemaType,
      });
      expect(refusal.message).toContain(`received a ${schemaType} schema`);
      expect(refusal.suggestion).toContain("separate kinds");
    },
  );

  it.each(NOT_OBJECT_SCHEMAS)(
    "defineEdge refuses a %s schema with a typed error",
    (_label, schemaType, schema) => {
      const refusal = refusalOf(() =>
        defineEdge("shapes", { schema: schema as never }),
      );
      expect(refusal.details).toEqual({
        code: "EDGE_SCHEMA_NOT_OBJECT",
        edgeType: "shapes",
        schemaType,
      });
    },
  );

  it("names a value that is not a Zod schema by its JavaScript type", () => {
    const refusal = refusalOf(() =>
      defineNode("Shape", { schema: "name" as never }),
    );
    expect(refusal.details).toMatchObject({ schemaType: "string" });
  });

  it.each(OBJECT_SCHEMAS)(
    "accepts a %s schema and stores through it",
    async (label, schema) => {
      const Item = defineNode("Item", { schema });
      const link = defineEdge("link", { schema });
      const store = await createLocalSqliteStore(
        defineGraph({
          id: `kind_schema_${label}`,
          nodes: { Item: { type: Item } },
          edges: { link: { type: link, from: [Item], to: [Item] } },
        }),
      );
      try {
        const first = await store.nodes.Item.create({ name: "a" });
        const second = await store.nodes.Item.create({ name: "b" });
        await store.edges.link.create(first, second, { name: "edge" });
        expect(await store.nodes.Item.find()).toHaveLength(2);
        expect(await store.edges.link.find()).toHaveLength(1);
      } finally {
        await store.close();
      }
    },
  );

  it("still defaults an edge without a schema to an empty object", () => {
    expect(() => defineEdge("bare")).not.toThrow();
  });
});
