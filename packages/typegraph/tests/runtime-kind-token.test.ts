import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../src";
import { type RuntimeNodeKind } from "../src/core/runtime-kind";
import { RuntimeKindTokenError } from "../src/errors";
import { defineGraphExtension } from "../src/graph-extension";
import { createStore, createStoreWithSchema } from "../src/store/store";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "runtime_kind_token",
  nodes: { Person: { type: Person } },
  edges: {},
});

const extension = defineGraphExtension({
  nodes: { Tag: { properties: { label: { type: "string" } } } },
  edges: {
    appliesTo: {
      from: ["Tag"],
      to: ["Person"],
      properties: { rank: { type: "number", int: true } },
    },
  },
});

const tagDefinition = extension.nodes.Tag;
const appliesToDefinition = extension.edges.appliesTo;

async function evolvedStore() {
  const backend = createTestBackend();
  const [store] = await createStoreWithSchema(graph, backend);
  const evolved = await store.evolve(extension);
  return { backend, evolved };
}

describe("runtime-kind tokens", () => {
  it("narrows persisted runtime collections and reuses the set-oriented bulk path", async () => {
    const { backend, evolved } = await evolvedStore();
    const [reloaded] = await createStoreWithSchema(graph, backend);
    const tag = reloaded.runtimeNodeKind("Tag", tagDefinition);
    const appliesTo = reloaded.runtimeEdgeKind(
      "appliesTo",
      appliesToDefinition,
    );

    const tags = reloaded.getNodeCollectionOrThrow(tag);
    const edges = reloaded.getEdgeCollectionOrThrow(appliesTo);
    const featured = await tags.create({ label: "featured" });
    const alice = await reloaded.nodes.Person.create({ name: "Alice" });
    await edges.create(featured, alice, { rank: 1 });

    expectTypeOf(featured.label).toEqualTypeOf<string>();
    const result = await reloaded.bulkFindRuntimeEdgesFrom({
      sources: [{ kind: tag, ids: [featured.id] }],
      edgeKinds: [appliesTo],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.source.kind).toBe("Tag");
    expect(result[0]?.edges[0]?.rank).toBe(1);
    expectTypeOf(result[0]?.edges[0]?.rank).toEqualTypeOf<number | undefined>();

    const query = reloaded
      .query()
      .fromDynamic(tag, "tag")
      .traverseDynamic(appliesTo, "applies")
      .toDynamic("Person", "person")
      .select((ctx) => {
        expectTypeOf(ctx.tag.label).toEqualTypeOf<string>();
        expectTypeOf(ctx.applies.rank).toEqualTypeOf<number>();
        return { id: ctx.person.id, rank: ctx.applies.rank };
      });
    await expect(query.execute()).resolves.toEqual([{ id: alice.id, rank: 1 }]);

    // The pre-reload Store has equivalent graph contents but not the owner that
    // issued these capabilities.
    expect(() => evolved.getNodeCollectionOrThrow(tag)).toThrow(
      expect.objectContaining({
        code: "RUNTIME_KIND_TOKEN_ERROR",
        reason: "wrong-store",
      }),
    );
  });

  it("refuses schema mismatches, forgeries, wrong entities, and stale evidence", async () => {
    const { evolved } = await evolvedStore();

    expect(() =>
      evolved.runtimeNodeKind("Tag", {
        properties: { label: { type: "number" } },
      }),
    ).toThrow(expect.objectContaining({ reason: "schema-mismatch" }));

    expect(() =>
      evolved.getNodeCollectionOrThrow({
        entity: "node",
        kind: "Tag",
      } as unknown as RuntimeNodeKind),
    ).toThrow(expect.objectContaining({ reason: "invalid" }));

    const edge = evolved.runtimeEdgeKind("appliesTo", appliesToDefinition);
    expect(() =>
      evolved.getNodeCollectionOrThrow(edge as unknown as RuntimeNodeKind),
    ).toThrow(expect.objectContaining({ reason: "wrong-entity" }));

    const tag = evolved.runtimeNodeKind("Tag", tagDefinition);
    await evolved.clear();
    expect(() => evolved.getNodeCollectionOrThrow(tag)).toThrow(
      expect.objectContaining({ reason: "stale" }),
    );
  });

  it("requires reconciled schema metadata before minting", () => {
    const store = createStore(graph, createTestBackend());
    expect(() => store.runtimeNodeKind("Tag", tagDefinition)).toThrow(
      RuntimeKindTokenError,
    );
    expect(() => store.runtimeNodeKind("Tag", tagDefinition)).toThrow(
      expect.objectContaining({ reason: "unreconciled" }),
    );
  });
});
