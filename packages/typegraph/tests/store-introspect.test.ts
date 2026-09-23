/**
 * Tests for `store.introspect()` and the throwing collection variants
 * `getNodeCollectionOrThrow` / `getEdgeCollectionOrThrow`.
 *
 * The introspection surface is the canonical schema-management API
 * — replaces the previous fragmented mix of `registry.hasNodeType`,
 * `store.deprecatedKinds`, and direct graph-poking. Per the pre-
 * release spec, the standalone `store.deprecatedKinds` accessor is
 * removed; consumers reach the deprecation set via
 * `store.introspect().deprecatedKinds`.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  KindNotFoundError,
  partOf,
} from "../src";
import { defineGraphExtension } from "../src/graph-extension";
import { createStoreWithSchema } from "../src/store/store";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const baseGraph = defineGraph({
  id: "introspect_test",
  nodes: { Person: { type: Person } },
  edges: {},
});

describe("Store.introspect", () => {
  it("returns compile-time kinds with origin: compile-time", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    const result = store.introspect();
    expect(result.graphId).toBe("introspect_test");
    const active = await backend.getActiveSchema(baseGraph.id);
    expect(result.schemaVersion).toBe(active?.version);
    expect(result.schemaHash).toBe(active?.schema_hash);
    expect(result.kinds).toHaveLength(1);
    const person = requireDefined(result.kinds[0]);
    expect(person.name).toBe("Person");
    expect(person.origin).toBe("compile-time");
    expect(person.deprecated).toBe(false);
    expect(result.extension).toBeUndefined();
    expect(result.deprecatedKinds.size).toBe(0);
  });

  it("includes graph-extension kinds with origin: runtime after evolve", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );

    const result = evolved.introspect();
    const active = await backend.getActiveSchema(baseGraph.id);
    expect(result.schemaVersion).toBe(active?.version);
    expect(result.schemaHash).toBe(active?.schema_hash);
    const tag = result.kinds.find((kind) => kind.name === "Tag");
    expect(tag).toBeDefined();
    expect(tag?.origin).toBe("runtime");
    expect(result.extension?.nodes?.["Tag"]).toBeDefined();
  });

  it("reflects deprecation state", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const deprecated = await store.deprecateKinds(["Person"]);

    const result = deprecated.introspect();
    const active = await backend.getActiveSchema(baseGraph.id);
    expect(result.schemaVersion).toBe(active?.version);
    expect(result.schemaHash).toBe(active?.schema_hash);
    const person = result.kinds.find((kind) => kind.name === "Person");
    expect(person?.deprecated).toBe(true);
    expect(result.deprecatedKinds.has("Person")).toBe(true);
  });

  it("includes graph-extension edges with origin: runtime", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
        edges: {
          appliesTo: { from: ["Tag"], to: ["Person"], properties: {} },
        },
      }),
    );

    const result = evolved.introspect();
    const edge = result.edges.find((entry) => entry.name === "appliesTo");
    expect(edge?.origin).toBe("runtime");
    expect(edge?.from).toEqual(["Tag"]);
    expect(edge?.to).toEqual(["Person"]);
    expect(edge?.acyclic).toBe(false);
  });

  it("includes a graph-extension edge's acyclic: true declaration", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Task: { properties: { name: { type: "string" } } } },
        edges: {
          dependsOn: {
            from: ["Task"],
            to: ["Task"],
            properties: {},
            acyclic: true,
          },
        },
      }),
    );

    const result = evolved.introspect();
    const edge = result.edges.find((entry) => entry.name === "dependsOn");
    expect(edge?.acyclic).toBe(true);
  });

  it("includes runtime ontology with origin: runtime", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: {
          Employee: { properties: { name: { type: "string" } } },
        },
        ontology: [{ metaEdge: "subClassOf", from: "Employee", to: "Person" }],
      }),
    );

    const result = evolved.introspect();
    const relation = result.ontology.find(
      (entry) => entry.from === "Employee" && entry.to === "Person",
    );
    expect(relation?.origin).toBe("runtime");
    expect(relation?.metaEdge).toBe("subClassOf");
  });

  it("reports `via` and `partSide` on a composition relation (E-a-r2-5)", async () => {
    // The only test of this copy site: OntologyIntrospection is the sole
    // one of the five via/partSide representations with no coverage, so a
    // dropped spread here is silent public-API data loss even though every
    // other copy site (serializer, deserializer, compiler, builders,
    // extension-validation) is caught by its own test.
    const Section = defineNode("Section", {
      schema: z.object({ title: z.string() }),
    });
    const parentSection = defineEdge("parentSection", {
      schema: z.object({}),
    });
    const graph = defineGraph({
      id: "introspect_composition_test",
      nodes: { Section: { type: Section } },
      edges: {
        parentSection: {
          type: parentSection,
          from: [Section],
          to: [Section],
          cardinality: "one",
        },
      },
      ontology: [
        partOf(Section, Section, { via: parentSection, partSide: "from" }),
      ],
    });
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const relation = store
      .introspect()
      .ontology.find((entry) => entry.metaEdge === "partOf");

    expect(relation?.via).toBe("parentSection");
    expect(relation?.partSide).toBe("from");
  });

  it("extension round-trips through defineGraphExtension", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const original = await store.evolve(
      defineGraphExtension({
        nodes: {
          Tag: { properties: { label: { type: "string" } } },
        },
      }),
    );
    const persistedDocument = requireDefined(original.introspect().extension);

    // Build a fresh graph + backend, then evolve with the introspected
    // document. The result should expose `Tag` again.
    const freshBackend = createTestBackend();
    const [freshStore] = await createStoreWithSchema(baseGraph, freshBackend);
    const reEvolved = await freshStore.evolve(persistedDocument);
    const reIntrospected = reEvolved.introspect();
    const tag = reIntrospected.kinds.find((kind) => kind.name === "Tag");
    expect(tag?.origin).toBe("runtime");
  });
});

describe("Store.getNodeCollectionOrThrow", () => {
  it("returns the collection for a registered kind", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const collection = store.getNodeCollectionOrThrow("Person");
    expect(collection).toBeDefined();
  });

  it("returns the collection for a graph-extension kind after evolve", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    const collection = evolved.getNodeCollectionOrThrow("Tag");
    expect(collection).toBeDefined();
    // Smoke test the throwing variant works for create.
    const created = await collection.create({ label: "alpha" });
    expect(created.kind).toBe("Tag");
  });

  it("throws KindNotFoundError for an unknown kind", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    expect(() => store.getNodeCollectionOrThrow("DoesNotExist")).toThrow(
      KindNotFoundError,
    );
  });
});

describe("Store.getEdgeCollectionOrThrow", () => {
  it("returns the collection for a graph-extension edge after evolve", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
        edges: {
          appliesTo: { from: ["Tag"], to: ["Person"], properties: {} },
        },
      }),
    );
    const collection = evolved.getEdgeCollectionOrThrow("appliesTo");
    expect(collection).toBeDefined();
  });

  it("throws KindNotFoundError for an unknown edge kind", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    expect(() => store.getEdgeCollectionOrThrow("DoesNotExist")).toThrow(
      KindNotFoundError,
    );
  });
});
