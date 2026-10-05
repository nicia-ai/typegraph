/**
 * A stored schema document and the same graph projected today must compare
 * equal even when the JSON Schema projection spells a construct differently.
 *
 * Two spellings changed between projections: a union of bare primitives
 * (`anyOf` members, then a `type` token array) and a tuple's arity (a bare
 * `prefixItems`, then `items: false` with `minItems` / `maxItems` restated).
 * Before these were folded, reopening a document stored under the earlier
 * spelling reported every such property as a breaking change and demanded a
 * migration for a schema that had not changed.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, type GraphDef } from "../src";
import type { GraphBackend } from "../src/backend/types";
import {
  computeSchemaDiff,
  computeSchemaHash,
  ensureSchema,
  getSchemaChanges,
  isStructuralSubtype,
  type JsonSchema,
  requiresMigration,
  type SerializedSchema,
  serializeSchema,
} from "../src/schema";
import { propertySchemasEqual } from "../src/schema/migration";
import { createStoreWithSchema, createVerifiedStore } from "../src/store";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

type JsonObject = Record<string, unknown>;

/**
 * Rewrites a projection into the spelling an earlier projection emitted:
 * unions of bare primitives as `anyOf`, tuples as a bare `prefixItems` (plus
 * the rest element's `items`, when there is one).
 */
function toEarlierSpelling(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((entry) => toEarlierSpelling(entry));
  }
  if (typeof node !== "object" || node === null) return node;
  const rewritten: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    rewritten[key] = toEarlierSpelling(value);
  }
  const { type } = rewritten;
  if (Array.isArray(type) && type.length > 1) {
    delete rewritten["type"];
    rewritten["anyOf"] = type.map((token: unknown) => ({ type: token }));
  }
  if (Array.isArray(rewritten["prefixItems"])) {
    if (rewritten["items"] === false) {
      delete rewritten["items"];
      delete rewritten["maxItems"];
    }
    delete rewritten["minItems"];
  }
  return rewritten;
}

const Item = defineNode("Item", {
  schema: z.object({
    nickname: z.string().nullable(),
    code: z.union([z.string(), z.number()]),
    point: z.tuple([z.number(), z.number()]),
    head: z.tuple([z.string()]).rest(z.number()),
    tags: z.array(z.string().nullable()),
  }),
});
const graph = defineGraph({
  id: "diff_projection_spelling",
  nodes: { Item: { type: Item } },
  edges: {},
});

/** Commits `graph`, then re-commits its document under the earlier spelling. */
async function storeUnderEarlierSpelling(
  backend: GraphBackend,
  target: GraphDef,
): Promise<number> {
  await createStoreWithSchema(target, backend);
  const active = requireDefined(await backend.getActiveSchema(target.id));
  const document = JSON.parse(active.schema_doc) as SerializedSchema;
  const version = active.version + 1;
  const schemaDocument = {
    ...(toEarlierSpelling(document) as SerializedSchema),
    version,
  };
  expect(JSON.stringify(schemaDocument.nodes)).not.toBe(
    JSON.stringify(document.nodes),
  );
  await backend.commitSchemaVersion({
    graphId: target.id,
    expected: { kind: "active", version: active.version },
    version,
    schemaHash: await computeSchemaHash(schemaDocument),
    schemaDoc: schemaDocument,
  });
  return version;
}

describe("a projection respelling is not a schema change", () => {
  it("reads a stored document under the earlier spelling as unchanged on every path", async () => {
    const backend = createTestBackend();
    const version = await storeUnderEarlierSpelling(backend, graph);

    const changes = await getSchemaChanges(backend, graph);
    expect(changes?.hasChanges ?? false).toBe(false);
    expect(await requiresMigration(backend, graph)).toBe(false);
    const [, verified] = await createVerifiedStore(graph, backend);
    expect(verified).toEqual({ status: "unchanged", version });
    expect(await ensureSchema(backend, graph)).toEqual({
      status: "unchanged",
      version,
    });
    const active = await backend.getActiveSchema(graph.id);
    expect(active?.version).toBe(version);
  });

  it("diffs the earlier spelling against the current one as no change", () => {
    const current = serializeSchema(graph, 1);
    const earlier = toEarlierSpelling(current) as SerializedSchema;

    expect(earlier.nodes["Item"]?.properties.properties).toMatchObject({
      nickname: { anyOf: [{ type: "string" }, { type: "null" }] },
      point: {
        type: "array",
        prefixItems: [{ type: "number" }, { type: "number" }],
      },
    });
    expect(computeSchemaDiff(earlier, current).hasChanges).toBe(false);
    expect(computeSchemaDiff(current, earlier).hasChanges).toBe(false);
  });

  it("still reports a genuine change to a respelled property as breaking", () => {
    const Widened = defineNode("Item", {
      schema: Item.schema.extend({
        nickname: z.union([z.string(), z.number(), z.null()]),
      }),
    });
    const widened = serializeSchema(
      defineGraph({
        id: graph.id,
        nodes: { Item: { type: Widened } },
        edges: {},
      }),
      2,
    );
    const earlier = toEarlierSpelling(
      serializeSchema(graph, 1),
    ) as SerializedSchema;

    const diff = computeSchemaDiff(earlier, widened);

    expect(diff.hasBreakingChanges).toBe(true);
    expect(diff.nodes.map((change) => change.details)).toEqual([
      expect.stringContaining(
        'Property schemas changed incompatibly in "Item": nickname.',
      ),
    ]);
  });
});

function equal(left: unknown, right: unknown): boolean {
  return propertySchemasEqual(left, right) && propertySchemasEqual(right, left);
}

describe("propertySchemasEqual over projection spellings", () => {
  it("folds a union of bare primitives, at any depth and beside sibling keywords", () => {
    expect(
      equal(
        { anyOf: [{ type: "string" }, { type: "null" }], minLength: 3 },
        { type: ["string", "null"], minLength: 3 },
      ),
    ).toBe(true);
    expect(
      equal(
        {
          type: "array",
          items: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        { type: "array", items: { type: ["string", "null"] } },
      ),
    ).toBe(true);
  });

  it("keeps a union whose member carries any other keyword", () => {
    expect(
      equal(
        { anyOf: [{ type: "string", minLength: 2 }, { type: "null" }] },
        { type: ["string", "null"] },
      ),
    ).toBe(false);
    expect(
      equal(
        { anyOf: [{ type: "string", "x-tag": "a" }, { type: "null" }] },
        { type: ["string", "null"] },
      ),
    ).toBe(false);
  });

  it("does not fold a union that sits beside its own type keyword", () => {
    expect(
      equal(
        { type: "string", anyOf: [{ type: "string" }, { type: "null" }] },
        { type: ["string", "null"] },
      ),
    ).toBe(false);
  });

  it("still sees a changed, added or reordered union member", () => {
    const earlier = { anyOf: [{ type: "string" }, { type: "null" }] };
    expect(equal(earlier, { type: ["number", "null"] })).toBe(false);
    expect(equal(earlier, { type: ["string", "null", "number"] })).toBe(false);
    expect(equal(earlier, { type: ["null", "string"] })).toBe(false);
  });

  it("folds a closed tuple whose arity is only restated", () => {
    const prefixItems = [{ type: "number" }, { type: "number" }];
    expect(
      equal(
        { type: "array", prefixItems },
        {
          type: "array",
          prefixItems,
          items: false,
          minItems: 2,
          maxItems: 2,
        },
      ),
    ).toBe(true);
  });

  it("folds a rest tuple whose minimum only restates its prefix", () => {
    const prefixItems = [{ type: "string" }];
    const items = { type: "number" };
    expect(
      equal(
        { type: "array", prefixItems, items },
        { type: "array", prefixItems, items, minItems: 1 },
      ),
    ).toBe(true);
  });

  it("keeps arity bounds that say more than the prefix length", () => {
    const prefixItems = [{ type: "string" }, { type: "number" }];
    const bare = { type: "array", prefixItems };
    // An optional trailing member: information the bare spelling never held.
    expect(
      equal(bare, {
        type: "array",
        prefixItems,
        items: false,
        minItems: 1,
        maxItems: 2,
      }),
    ).toBe(false);
    // A rest tuple is not the closed tuple the bare spelling denotes.
    expect(equal(bare, { type: "array", prefixItems, items: {} })).toBe(false);
    // `maxItems` on an open tuple bounds the rest elements; it restates nothing.
    expect(
      equal(
        { type: "array", prefixItems, items: { type: "number" } },
        {
          type: "array",
          prefixItems,
          items: { type: "number" },
          maxItems: 2,
        },
      ),
    ).toBe(false);
    // A homogeneous array's bounds are untouched.
    expect(
      equal(
        { type: "array", items: { type: "number" } },
        { type: "array", items: { type: "number" }, minItems: 0 },
      ),
    ).toBe(false);
  });

  it("never rewrites instance data or unknown extension keys", () => {
    const earlier = { anyOf: [{ type: "string" }, { type: "null" }] };
    const current = { type: ["string", "null"] };
    for (const key of ["default", "const", "examples", "x-config"]) {
      expect(
        equal(
          { type: "object", [key]: earlier },
          { type: "object", [key]: current },
        ),
      ).toBe(false);
    }
    expect(
      equal({ ...earlier, "x-config": 1 }, { ...current, "x-config": 2 }),
    ).toBe(false);
  });
});

describe("isStructuralSubtype over projection spellings", () => {
  it("reads a tuple and its restated-arity spelling as mutual subtypes", () => {
    const prefixItems: JsonSchema[] = [{ type: "number" }, { type: "number" }];
    const earlier: JsonSchema = { type: "array", prefixItems };
    const current: JsonSchema = {
      type: "array",
      prefixItems,
      items: false,
      minItems: 2,
      maxItems: 2,
    };

    expect(isStructuralSubtype(earlier, current)).toEqual({
      verdict: "subtype",
    });
    expect(isStructuralSubtype(current, earlier)).toEqual({
      verdict: "subtype",
    });
  });
});
