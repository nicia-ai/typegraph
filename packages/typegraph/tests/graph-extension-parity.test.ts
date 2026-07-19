/**
 * Graph extension — public-Store-API parity matrix.
 *
 * Issue 101's acceptance gate: every public Store API path must work
 * when the kind is declared via `evolve(extension)`. The basic CRUD
 * slice lives in `store-evolve.test.ts`; this file extends the matrix
 * to:
 *
 *   - Query predicates (`.find({ where })`, `.count({ where })`)
 *   - Subgraphs (`store.subgraph(...)`)
 *   - Fulltext (`store.search.fulltext` against a graph-extension kind whose
 *     property carries the `searchable` modifier)
 *   - Ontology (subClassOf inference across graph-extension kinds)
 *   - Graph algorithms (`store.algorithms.neighbors` / `shortestPath`)
 *
 * The static type system narrows `Store<G>` to compile-time kinds, so
 * reaching a graph-extension kind through a typed API requires the documented
 * `"<kind>" as never` cast — same pattern the example file uses. That
 * is the graph-extension contract: the dynamic CRUD accessor (
 * `getNodeCollection`) is fully widened, and the few generically-typed
 * facades (`search.fulltext`, `algorithms.*`, `subgraph`) accept a
 * cast at the kind/edge name parameter.
 *
 * SQLite-only here (the bundled test backend). The graph-extension
 * code path is dialect-agnostic — kind resolution and merge happen in
 * dialect-neutral code, and the dialect-specific tests
 * (`tests/backends/postgres/`) already verify the same operations
 * work end-to-end on Postgres.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../src";
import { searchable } from "../src/core/searchable";
import { defineGraphExtension } from "../src/graph-extension";
import { createStoreWithSchema } from "../src/store/store";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

// ============================================================
// Setup
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const baseGraph = defineGraph({
  id: "runtime_parity",
  nodes: { Person: { type: Person } },
  edges: {},
});

// ============================================================
// Query predicates
// ============================================================

describe("Store.evolve — query predicate parity", () => {
  it("collection.find with where + limit works on a graph-extension kind", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: {
          Article: {
            properties: {
              title: { type: "string" },
              wordCount: { type: "number", int: true, min: 0 },
            },
          },
        },
      }),
    );

    const articles = requireDefined(evolved.getNodeCollection("Article"));
    await articles.create({ title: "alpha", wordCount: 100 });
    await articles.create({ title: "beta", wordCount: 250 });
    await articles.create({ title: "gamma", wordCount: 50 });

    type Article = Readonly<{ id: string; title: string; wordCount: number }>;

    // The dynamic-collection `find({ where })` accepts an accessor-
    // backed predicate just like the typed collection. Graph-extension
    // kinds participate in predicate compilation through the same
    // path. The `as never` on the callback bypasses the static
    // schema-shape type — graph-extension kinds aren't reflected in the
    // generic, but the AST is built dynamically at runtime.
    const longArticles = (await articles.find({
      where: ((props: { wordCount: { gte: (n: number) => unknown } }) =>
        props.wordCount.gte(100)) as never,
    })) as unknown as Article[];
    expect(longArticles.map((article) => article.title).toSorted()).toEqual([
      "alpha",
      "beta",
    ]);

    // Pagination via limit + offset also flows through.
    const firstTwo = (await articles.find({
      limit: 2,
    })) as unknown as Article[];
    expect(firstTwo).toHaveLength(2);
  });

  it("count with where filters graph-extension-kind rows correctly", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: {
          Article: {
            properties: { published: { type: "boolean" } },
          },
        },
      }),
    );
    const articles = requireDefined(evolved.getNodeCollection("Article"));
    await articles.create({ published: true });
    await articles.create({ published: false });
    await articles.create({ published: true });

    // Total count.
    expect(await articles.count()).toBe(3);

    // QueryOptions doesn't expose `where` at the dynamic-collection
    // level — predicate filtering goes through `.find({ where })`,
    // and counting filtered rows is done via `(await find({ where })).length`.
    const published = (await articles.find({
      where: ((props: { published: { eq: (b: boolean) => unknown } }) =>
        props.published.eq(true)) as never,
    })) as unknown as readonly { id: string }[];
    expect(published).toHaveLength(2);
  });
});

// ============================================================
// Subgraphs
// ============================================================

describe("Store.evolve — subgraph parity", () => {
  it("store.subgraph traverses through graph-extension edges from a compile-time root", async () => {
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

    // Seed: one Person, two Tags, one edge from each Tag to Person.
    const alice = await evolved.nodes.Person.create({ name: "alice" });
    const tags = requireDefined(evolved.getNodeCollection("Tag"));
    type ExtensionTag = Readonly<{ id: string; kind: string; label: string }>;
    const featured = (await tags.create({
      label: "featured",
    })) as unknown as ExtensionTag;
    const archived = (await tags.create({
      label: "archived",
    })) as unknown as ExtensionTag;
    const appliesTo = requireDefined(evolved.getEdgeCollection("appliesTo"));
    await appliesTo.create({ kind: "Tag", id: featured.id }, alice, {});
    await appliesTo.create({ kind: "Tag", id: archived.id }, alice, {});

    // Subgraph rooted on alice expanding the runtime `appliesTo`
    // edge. `direction: "both"` lets the traversal reach Tag nodes
    // via the incoming edge — `appliesTo` is declared `Tag → Person`,
    // so the default outward-only direction wouldn't pick them up.
    // The edge name is a graph-extension kind, so it requires the `as never`
    // cast — same pattern as `store.search.fulltext("Paper" as never)`
    // shown in the runnable example.
    const result = await evolved.subgraph(alice.id, {
      edges: ["appliesTo" as never],
      maxDepth: 1,
      direction: "both",
    });

    // The two Tag nodes were reached via the appliesTo edges.
    // `node.kind` is typed against compile-time kinds; graph-extension kind
    // comparison goes through an `unknown` cast.
    const tagIds = [...result.nodes.values()]
      .filter((node) => (node.kind as unknown as string) === "Tag")
      .map((node) => node.id)
      .toSorted();
    expect(tagIds).toEqual([featured.id, archived.id].toSorted());
  });
});

// ============================================================
// Fulltext
// ============================================================

describe("Store.evolve — fulltext parity", () => {
  it("searchable() modifier on a graph-extension kind feeds store.search.fulltext", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: {
          Note: {
            properties: {
              title: { type: "string", searchable: { language: "english" } },
              body: { type: "string", searchable: { language: "english" } },
            },
          },
        },
      }),
    );

    const notes = requireDefined(evolved.getNodeCollection("Note"));
    await notes.create({
      title: "Climate change drivers",
      body: "Rising global temperatures linked to greenhouse emissions",
    });
    await notes.create({
      title: "Local cuisine guide",
      body: "Ten restaurants worth visiting in town this weekend",
    });

    // No cast: `store.search.fulltext` accepts any registered kind
    // — compile-time or graph-extension. The hit's `node` type widens to the
    // base `Node` for graph-extension kinds since the literal isn't in
    // `Store<G>`'s static type.
    const results = await evolved.search.fulltext("Note", {
      query: "climate temperatures",
      limit: 10,
    });
    expect(results.length).toBeGreaterThan(0);
    const top = requireDefined(results[0]).node as unknown as { title: string };
    expect(top.title).toBe("Climate change drivers");
  });

  it("compile-time-vs-runtime fulltext returns equivalent results", async () => {
    // Compile-time control.
    const Note = defineNode("Note", {
      schema: z.object({
        title: searchable({ language: "english" }),
        body: searchable({ language: "english" }),
      }),
    });
    const compileGraph = defineGraph({
      id: "runtime_parity_fulltext_compile",
      nodes: { Note: { type: Note } },
      edges: {},
    });
    const compileBackend = createTestBackend();
    const [compileStore] = await createStoreWithSchema(
      compileGraph,
      compileBackend,
    );
    await compileStore.nodes.Note.create({
      title: "Renewable energy outlook",
      body: "Solar and wind capacity",
    });
    const compileResults = await compileStore.search.fulltext("Note", {
      query: "solar wind",
      limit: 10,
    });

    // Graph-extension equivalent.
    const runtimeBackend = createTestBackend();
    const baseForExtension = defineGraph({
      id: "runtime_parity_fulltext_runtime",
      nodes: { Person: { type: Person } },
      edges: {},
    });
    const [runtimeBase] = await createStoreWithSchema(
      baseForExtension,
      runtimeBackend,
    );
    const evolved = await runtimeBase.evolve(
      defineGraphExtension({
        nodes: {
          Note: {
            properties: {
              title: { type: "string", searchable: { language: "english" } },
              body: { type: "string", searchable: { language: "english" } },
            },
          },
        },
      }),
    );
    const notes = requireDefined(evolved.getNodeCollection("Note"));
    await notes.create({
      title: "Renewable energy outlook",
      body: "Solar and wind capacity",
    });
    const runtimeResults = await evolved.search.fulltext("Note", {
      query: "solar wind",
      limit: 10,
    });

    expect(runtimeResults.length).toBe(compileResults.length);
    const compileTitle = (
      requireDefined(compileResults[0]).node as unknown as {
        title: string;
      }
    ).title;
    const runtimeTitle = (
      requireDefined(runtimeResults[0]).node as unknown as {
        title: string;
      }
    ).title;
    expect(runtimeTitle).toBe(compileTitle);
  });
});

// ============================================================
// Ontology
// ============================================================

describe("Store.evolve — ontology parity", () => {
  it("subClassOf relations across graph-extension kinds participate in registry closures", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: {
          Document: { properties: { title: { type: "string" } } },
          Article: { properties: { title: { type: "string" } } },
          BlogPost: { properties: { title: { type: "string" } } },
        },
        ontology: [
          { metaEdge: "subClassOf", from: "Article", to: "Document" },
          { metaEdge: "subClassOf", from: "BlogPost", to: "Article" },
        ],
      }),
    );

    // Registry closure: BlogPost → Article → Document.
    const ancestors = evolved.registry.getAncestors("BlogPost");
    expect([...ancestors].toSorted()).toEqual(
      ["Article", "Document"].toSorted(),
    );
    const descendants = evolved.registry.getDescendants("Document");
    expect([...descendants].toSorted()).toEqual(
      ["Article", "BlogPost"].toSorted(),
    );
  });

  it("subClassOf bridges graph-extension kind to compile-time kind", async () => {
    // A graph-extension kind can be declared as a subclass of a compile-time
    // kind. The ontology closure must pick up the relation.
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

    const ancestors = evolved.registry.getAncestors("Employee");
    expect([...ancestors]).toContain("Person");
  });
});

// ============================================================
// Graph algorithms
// ============================================================

describe("Store.evolve — algorithm parity", () => {
  it("neighbors traverses through graph-extension edges between graph-extension kinds", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: {
          Module: { properties: { name: { type: "string" } } },
        },
        edges: {
          dependsOn: { from: ["Module"], to: ["Module"], properties: {} },
        },
      }),
    );
    const modules = requireDefined(evolved.getNodeCollection("Module"));
    type Module = Readonly<{ id: string; kind: string; name: string }>;
    const a = (await modules.create({ name: "a" })) as unknown as Module;
    const b = (await modules.create({ name: "b" })) as unknown as Module;
    const c = (await modules.create({ name: "c" })) as unknown as Module;
    const dependsOn = requireDefined(evolved.getEdgeCollection("dependsOn"));
    await dependsOn.create(
      { kind: "Module", id: a.id },
      { kind: "Module", id: b.id },
      {},
    );
    await dependsOn.create(
      { kind: "Module", id: b.id },
      { kind: "Module", id: c.id },
      {},
    );

    const directNeighbors = await evolved.algorithms.neighbors(a.id, {
      edges: ["dependsOn" as never],
    });
    expect(directNeighbors.map((row) => row.id)).toEqual([b.id]);

    const twoHopNeighbors = await evolved.algorithms.neighbors(a.id, {
      edges: ["dependsOn" as never],
      depth: 2,
    });
    expect(twoHopNeighbors.map((row) => row.id).toSorted()).toEqual(
      [b.id, c.id].toSorted(),
    );
  });

  it("shortestPath traverses graph-extension edges to compile-time targets", async () => {
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

    const alice = await evolved.nodes.Person.create({ name: "alice" });
    type ExtensionTag = Readonly<{ id: string; kind: string; label: string }>;
    const tags = requireDefined(evolved.getNodeCollection("Tag"));
    const featured = (await tags.create({
      label: "featured",
    })) as unknown as ExtensionTag;
    const appliesTo = requireDefined(evolved.getEdgeCollection("appliesTo"));
    await appliesTo.create({ kind: "Tag", id: featured.id }, alice, {});

    const path = await evolved.algorithms.shortestPath(featured.id, alice.id, {
      edges: ["appliesTo" as never],
    });
    expect(path?.depth).toBe(1);
    expect(path?.nodes.map((node) => node.kind)).toEqual(["Tag", "Person"]);
  });
});
