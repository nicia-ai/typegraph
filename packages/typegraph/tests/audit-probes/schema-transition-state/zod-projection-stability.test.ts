import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../../../src";
import type { GraphBackend } from "../../../src/backend/types";
import {
  ensureSchema,
  getSchemaChanges,
  requiresMigration,
} from "../../../src/schema/manager";
import { computeSchemaHash } from "../../../src/schema/serializer";
import type { SerializedSchema } from "../../../src/schema/types";
import { createStoreWithSchema } from "../../../src/store/store";
import { createTestBackend } from "../../test-utils";

type Json = Record<string, unknown>;

/** Rewrites a projection into the spelling Zod emitted before type arrays. */
function toOlderSpelling(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((entry) => toOlderSpelling(entry));
  if (typeof node !== "object" || node === null) return node;
  const source = node as Json;
  const out: Json = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = toOlderSpelling(value);
  }
  if (Array.isArray(out.type) && out.type.length > 1) {
    const members = out.type as string[];
    delete out.type;
    out.anyOf = members.map((type) => ({ type }));
  }
  if (Array.isArray(out.prefixItems)) {
    if (out.items === false) delete out.items;
    if (out.items === undefined) {
      delete out.minItems;
      delete out.maxItems;
    }
  }
  return out;
}

async function storeUnderOlderSpelling(
  backend: GraphBackend,
  graph: Parameters<typeof createStoreWithSchema>[0],
): Promise<number> {
  await createStoreWithSchema(graph, backend);
  const active = await backend.getActiveSchema(graph.id);
  if (active === undefined) throw new Error("no active schema");
  const document = JSON.parse(active.schema_doc) as SerializedSchema;
  const rewritten = toOlderSpelling(document) as SerializedSchema;
  expect(JSON.stringify(rewritten)).not.toBe(JSON.stringify(document));
  const version = active.version + 1;
  const schemaDoc = { ...rewritten, version };
  await backend.commitSchemaVersion({
    graphId: graph.id,
    expected: { kind: "active", version: active.version },
    version,
    schemaHash: await computeSchemaHash(schemaDoc),
    schemaDoc,
  });
  return version;
}

const Item = defineNode("Item", {
  schema: z.object({
    nickname: z.string().nullable(),
    code: z.union([z.string(), z.number()]),
    point: z.tuple([z.number(), z.number()]),
    tags: z.array(z.string().nullable()),
  }),
});
const graph = defineGraph({
  id: "audit_zod_projection",
  nodes: { Item: { type: Item } },
  edges: {},
});

describe("audit: stored document under the older Zod projection", () => {
  it("zod-projection-unchanged-no-diff", async () => {
    const backend = createTestBackend();
    const version = await storeUnderOlderSpelling(backend, graph);
    const changes = await getSchemaChanges(backend, graph);
    expect(changes?.hasChanges ?? false).toBe(false);
    expect(await requiresMigration(backend, graph)).toBe(false);
    const result = await ensureSchema(backend, graph);
    expect(result.status).toBe("unchanged");
    expect((await backend.getActiveSchema(graph.id))?.version).toBe(version);
  });
});
