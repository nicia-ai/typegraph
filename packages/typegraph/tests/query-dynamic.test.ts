import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  EndpointError,
  KindNotFoundError,
} from "../src";
import { defineGraphExtension } from "../src/graph-extension";
import {
  type DynamicSelectableEdge,
  type DynamicSelectableNode,
} from "../src/query/builder/dynamic";
import { createStoreWithSchema } from "../src/store/store";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

const Document = defineNode("Document", {
  schema: z.object({
    title: z.string(),
  }),
});

const baseGraph = defineGraph({
  id: "query_dynamic",
  nodes: { Document: { type: Document } },
  edges: {},
});

const paperExtension = defineGraphExtension({
  nodes: {
    Paper: {
      properties: {
        title: { type: "string", minLength: 1 },
        year: { type: "number", int: true, min: 1900, max: 2100 },
      },
    },
    Author: {
      properties: {
        name: { type: "string", minLength: 1 },
      },
    },
  },
  edges: {
    authoredBy: {
      from: ["Paper"],
      to: ["Author"],
      properties: {
        order: { type: "number", int: true, min: 1 },
      },
    },
  },
});

describe("fromDynamic", () => {
  it("queries a runtime kind by string name", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(paperExtension);

    const papers = evolved.getNodeCollectionOrThrow("Paper");
    await papers.create({ title: "Attention is all you need", year: 2017 });
    await papers.create({ title: "GPT-3", year: 2020 });
    await papers.create({ title: "Older paper", year: 1999 });

    const rows = await evolved
      .query()
      .fromDynamic("Paper", "p")
      .whereNode("p", (p) => p.field("year").number().gte(2017))
      .select((ctx) => ctx.p)
      .execute();

    expect(rows).toHaveLength(2);
    const titles = rows.map((row) => row["title"]).toSorted();
    expect(titles).toEqual(["Attention is all you need", "GPT-3"]);

    expectTypeOf(requireDefined(rows[0])).toExtend<DynamicSelectableNode>();
    const firstRow = requireDefined(rows[0]);
    expect(typeof firstRow.id).toBe("string");
    expect(firstRow.kind).toBe("Paper");
    expect(typeof firstRow.meta.version).toBe("number");
    expect(typeof firstRow.meta.createdAt).toBe("string");
  });

  it("throws KindNotFoundError on unknown kind", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    expect(() => store.query().fromDynamic("Ppaer", "p")).toThrow(
      KindNotFoundError,
    );
  });
});

describe("traverseDynamic + toDynamic", () => {
  it("traverses runtime edges across runtime targets", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(paperExtension);

    const papers = evolved.getNodeCollectionOrThrow("Paper");
    const authors = evolved.getNodeCollectionOrThrow("Author");
    const authoredBy = evolved.getEdgeCollectionOrThrow("authoredBy");

    const transformer = await papers.create({
      title: "Transformer",
      year: 2017,
    });
    const gpt2 = await papers.create({ title: "GPT-2", year: 2019 });
    const vaswani = await authors.create({ name: "Ashish Vaswani" });
    const radford = await authors.create({ name: "Alec Radford" });

    await authoredBy.create(transformer, vaswani, { order: 1 });
    await authoredBy.create(gpt2, radford, { order: 1 });

    const rows = await evolved
      .query()
      .fromDynamic("Paper", "p")
      .traverseDynamic("authoredBy", "a")
      .toDynamic("Author", "u")
      .whereNode("p", (p) => p.field("year").number().gte(2018))
      .select((ctx) => ({ paper: ctx.p, author: ctx.u, edge: ctx.a }))
      .execute();

    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.paper["title"]).toBe("GPT-2");
    expect(row?.author["name"]).toBe("Alec Radford");
    expect(row?.edge.kind).toBe("authoredBy");

    expectTypeOf(requireDefined(row).paper).toExtend<DynamicSelectableNode>();
    expectTypeOf(requireDefined(row).author).toExtend<DynamicSelectableNode>();
    expectTypeOf(requireDefined(row).edge).toExtend<DynamicSelectableEdge>();
  });

  it("filters on runtime-edge properties via whereEdge", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(paperExtension);

    const papers = evolved.getNodeCollectionOrThrow("Paper");
    const authors = evolved.getNodeCollectionOrThrow("Author");
    const authoredBy = evolved.getEdgeCollectionOrThrow("authoredBy");

    const paper = await papers.create({ title: "P", year: 2021 });
    const first = await authors.create({ name: "First" });
    const second = await authors.create({ name: "Second" });

    await authoredBy.create(paper, first, { order: 1 });
    await authoredBy.create(paper, second, { order: 2 });

    const rows = await evolved
      .query()
      .fromDynamic("Paper", "p")
      .traverseDynamic("authoredBy", "a")
      .whereEdge("a", (edge) => edge.field("order").number().eq(1))
      .toDynamic("Author", "u")
      .select((ctx) => ctx.u)
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.["name"]).toBe("First");
  });

  it("throws KindNotFoundError on unknown edge or target kind", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(paperExtension);

    expect(() =>
      evolved
        .query()
        .fromDynamic("Paper", "p")
        .traverseDynamic("autoredBy", "a"),
    ).toThrow(KindNotFoundError);

    expect(() =>
      evolved
        .query()
        .fromDynamic("Paper", "p")
        .traverseDynamic("authoredBy", "a")
        .toDynamic("Athor", "u"),
    ).toThrow(KindNotFoundError);
  });

  it("throws EndpointError when toDynamic target is not a valid endpoint", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(paperExtension);

    // authoredBy.to=[Author], so Paper isn't a valid target for the
    // outgoing traversal — typed `to()` would catch this at compile
    // time; toDynamic catches it at runtime.
    expect(() =>
      evolved
        .query()
        .fromDynamic("Paper", "p")
        .traverseDynamic("authoredBy", "a")
        .toDynamic("Paper", "wrong"),
    ).toThrow(EndpointError);
  });
});

describe("optionalTraverseDynamic", () => {
  it("LEFT JOINs over a runtime edge — papers without authors still surface", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(paperExtension);

    const papers = evolved.getNodeCollectionOrThrow("Paper");
    const authors = evolved.getNodeCollectionOrThrow("Author");
    const authoredBy = evolved.getEdgeCollectionOrThrow("authoredBy");

    const cited = await papers.create({ title: "cited", year: 2020 });
    await papers.create({ title: "orphan", year: 2021 });
    const author = await authors.create({ name: "A. Author" });
    await authoredBy.create(cited, author, { order: 1 });

    const rows = await evolved
      .query()
      .fromDynamic("Paper", "p")
      .optionalTraverseDynamic("authoredBy", "a")
      .toDynamic("Author", "u")
      .select((ctx) => ({
        paperTitle: ctx.p["title"],
        authorName: ctx.u?.["name"],
      }))
      .execute();

    expect(rows).toHaveLength(2);
    const byTitle = new Map(
      rows.map((row) => [row.paperTitle, row.authorName]),
    );
    expect(byTitle.get("cited")).toBe("A. Author");
    expect(byTitle.get("orphan")).toBeUndefined();
  });

  it("throws KindNotFoundError on unknown edge", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(paperExtension);

    expect(() =>
      evolved
        .query()
        .fromDynamic("Paper", "p")
        .optionalTraverseDynamic("autoredBy", "a"),
    ).toThrow(KindNotFoundError);
  });
});

describe("typed-edge preservation under toDynamic", () => {
  it("typed traverse + toDynamic keeps the edge alias's typed accessor", async () => {
    // Compile-time graph: Person -[reads { count: number }]-> Doc.
    // The user takes the typed `traverse("reads", "e")` path then ends
    // with `toDynamic("Doc", "d")` (e.g., kind comes from a string
    // variable). The edge alias `e` must stay typed — `e.count.gte(2)`
    // works directly, no `.field("count").number()` discriminator.
    const Person = defineNode("Person", {
      schema: z.object({ name: z.string() }),
    });
    const Document_ = defineNode("Doc", {
      schema: z.object({ title: z.string() }),
    });
    const reads = defineEdge("reads", {
      schema: z.object({ count: z.number() }),
    });
    const graph = defineGraph({
      id: "typed_edge_dyn_target",
      nodes: { Person: { type: Person }, Doc: { type: Document_ } },
      edges: { reads: { type: reads, from: [Person], to: [Document_] } },
    });

    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const ada = await store.nodes.Person.create({ name: "Ada" });
    const document = await store.nodes.Doc.create({ title: "the doc" });
    await store.edges.reads.create(ada, document, { count: 3 });

    const rows = await store
      .query()
      .from("Person", "p")
      .traverse("reads", "e")
      // `e.count` is typed as NumberFieldAccessor — `.gte(2)` is direct.
      .whereEdge("e", (edge) => edge.count.gte(2))
      .toDynamic("Doc", "d")
      .select((ctx) => ({ personName: ctx.p.name, count: ctx.e.count }))
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.personName).toBe("Ada");
    expect(rows[0]?.count).toBe(3);
  });
});

describe("mixed typed + dynamic aliases", () => {
  it("preserves typed accessors on typed aliases when mixed with dynamic ones", async () => {
    const bridgeExtension = defineGraphExtension({
      nodes: {
        Tag: {
          properties: { label: { type: "string", minLength: 1 } },
        },
      },
      edges: {
        taggedWith: {
          from: ["Document"],
          to: ["Tag"],
          properties: {},
        },
      },
    });

    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(bridgeExtension);

    const document = await evolved.nodes.Document.create({ title: "the doc" });
    const tags = evolved.getNodeCollectionOrThrow("Tag");
    const taggedWith = evolved.getEdgeCollectionOrThrow("taggedWith");

    const ml = await tags.create({ label: "machine-learning" });
    const research = await tags.create({ label: "research" });
    await taggedWith.create(document, ml, {});
    await taggedWith.create(document, research, {});

    const rows = await evolved
      .query()
      .from("Document", "d")
      .traverseDynamic("taggedWith", "e")
      .toDynamic("Tag", "n")
      // Typed alias keeps StringFieldAccessor — `.eq()` directly on the
      // schema property without a discriminator.
      .whereNode("d", (d) => d.title.eq("the doc"))
      // Dynamic alias goes through `.field("name").string()`.
      .whereNode("n", (n) => n.field("label").string().eq("research"))
      .select((ctx) => ({ doc: ctx.d, tag: ctx.n }))
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.doc.title).toBe("the doc");
    expect(rows[0]?.tag["label"]).toBe("research");
  });
});

describe(".field() discriminator", () => {
  it("throws when the property is not on the schema", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(paperExtension);

    expect(() =>
      evolved
        .query()
        .fromDynamic("Paper", "p")
        .whereNode("p", (p) => p.field("yera").number().gte(2017)),
    ).toThrow(/Property "yera" is not declared/);
  });

  it("throws TypeError on discriminator mismatch", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(paperExtension);

    expect(() =>
      evolved
        .query()
        .fromDynamic("Paper", "p")
        .whereNode("p", (p) => p.field("year").string().eq("2017")),
    ).toThrow(TypeError);
  });

  it("admits BaseFieldAccessor methods without a discriminator", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(paperExtension);

    const papers = evolved.getNodeCollectionOrThrow("Paper");
    await papers.create({ title: "alpha", year: 2017 });
    await papers.create({ title: "beta", year: 2022 });

    const rows = await evolved
      .query()
      .fromDynamic("Paper", "p")
      // .eq is on BaseFieldAccessor — no discriminator needed for the
      // common predicates.
      .whereNode("p", (p) => p.field("title").eq("alpha"))
      .select((ctx) => ctx.p)
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.["title"]).toBe("alpha");
  });
});

describe("compile-time typing", () => {
  it("preserves store.query().from() typing for typed kinds", () => {
    const backend = createTestBackend();
    void (async () => {
      const [store] = await createStoreWithSchema(baseGraph, backend);

      // @ts-expect-error — "Paper" not in baseGraph["nodes"].
      store.query().from("Paper", "p");

      store.query().fromDynamic("Paper", "p");
    });
  });
});
