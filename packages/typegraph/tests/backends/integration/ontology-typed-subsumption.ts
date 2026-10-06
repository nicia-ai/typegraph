/**
 * Cross-backend query semantics for typed subsumption.
 *
 * Query-feature tests live in the shared cross-backend suite (AGENTS.md
 * "Backend parity") — a per-dialect test would happily certify a
 * divergence between SQLite and PostgreSQL; only the same case run on both
 * engines verifies equivalence.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  broader,
  count,
  defineEdge,
  defineGraph,
  defineNode,
  embedding,
  field,
  searchable,
  subClassOf,
} from "../../../src";
import { ConfigurationError, EndpointError } from "../../../src/errors";
import { type IntegrationTestContext } from "./test-context";

const Media = defineNode("TsMedia", {
  schema: z.object({ title: z.string() }),
});
const Podcast = defineNode("TsPodcast", {
  schema: z.object({ title: z.string(), rssUrl: z.string() }),
});
const linksTo = defineEdge("tsLinksTo", { schema: z.object({}) });

const subsumptionGraph = defineGraph({
  id: "typed_subsumption_integration",
  nodes: { TsMedia: { type: Media }, TsPodcast: { type: Podcast } },
  edges: {
    tsLinksTo: { type: linksTo, from: [Media], to: [Media] },
  },
  ontology: [subClassOf(Podcast, Media)],
});

// A three-level `broader` chain: Root -> Mid -> Leaf (Leaf is the most
// specific concept; `broader(narrower, broader)` per the factory's own
// parameter order).
const RootConcept = defineNode("TsRootConcept", {
  schema: z.object({ name: z.string() }),
});
const MidConcept = defineNode("TsMidConcept", {
  schema: z.object({ name: z.string() }),
});
const LeafConcept = defineNode("TsLeafConcept", {
  schema: z.object({ name: z.string() }),
});
// `from`/`to` declared directly on each EdgeType (not only in the graph's
// edge registration) — `#assertValidEndpoint`'s admitted-kinds set reads
// `registry.getEdgeType(name).to`, which is only populated when the edge
// type itself carries endpoints.
//
// Two edges, deliberately different admitted `to` sets: `tsConceptLink`
// admits every concept kind (the narrower-expansion SUCCESS case),
// `tsConceptLinkNarrow` admits only the root (the endpoint-refused case) —
// `expansion: "narrower"` is not an assignability axis, so admission must be
// declared explicitly per kind, unlike `subClassOf` expansion.
const conceptLink = defineEdge("tsConceptLink", {
  schema: z.object({}),
  from: [RootConcept],
  to: [RootConcept, MidConcept, LeafConcept],
});
const conceptLinkNarrow = defineEdge("tsConceptLinkNarrow", {
  schema: z.object({}),
  from: [RootConcept],
  to: [RootConcept],
});
// The same root-only admission as `tsConceptLinkNarrow`, declared where graphs
// normally declare endpoints: on the graph's edge registration, with a bare
// edge type that carries none of its own.
const conceptLinkGraphNarrow = defineEdge("tsConceptLinkGraphNarrow", {
  schema: z.object({}),
});

const narrowerGraph = defineGraph({
  id: "typed_narrower_integration",
  nodes: {
    TsRootConcept: { type: RootConcept },
    TsMidConcept: { type: MidConcept },
    TsLeafConcept: { type: LeafConcept },
  },
  edges: {
    tsConceptLink: conceptLink,
    tsConceptLinkNarrow: conceptLinkNarrow,
    tsConceptLinkGraphNarrow: {
      type: conceptLinkGraphNarrow,
      from: [RootConcept],
      to: [RootConcept],
    },
  },
  ontology: [
    broader(MidConcept, RootConcept),
    broader(LeafConcept, MidConcept),
  ],
});

// Search fixture: a distinct graph so its `searchable()` and `embedding()`
// fields don't have to be threaded through `subsumptionGraph`'s other,
// non-search cases.
const SearchMedia = defineNode("TsSearchMedia", {
  schema: z.object({
    title: searchable({ language: "english" }),
    embedding: embedding(4).optional(),
  }),
});
const SearchPodcast = defineNode("TsSearchPodcast", {
  schema: z.object({
    title: searchable({ language: "english" }),
    embedding: embedding(4).optional(),
    rssUrl: z.string(),
  }),
});
const SEARCH_QUERY_EMBEDDING = [1, 0, 0, 0];
const SEARCH_KINDS = ["TsSearchMedia", "TsSearchPodcast"];

const searchGraph = defineGraph({
  id: "typed_subsumption_search_integration",
  nodes: {
    TsSearchMedia: { type: SearchMedia },
    TsSearchPodcast: { type: SearchPodcast },
  },
  edges: {},
  ontology: [subClassOf(SearchPodcast, SearchMedia)],
});

// A hierarchy the structural contract admits: the subclass omits every
// parent-optional property, and narrows `code` from `string | number` to
// `string`. The parent alias promises the parent's property types.
const OptionalMedia = defineNode("TsOptionalMedia", {
  schema: z.object({
    title: z.string(),
    tags: z.array(z.string()).optional(),
    featured: z.boolean().optional(),
    info: z.object({ lang: z.string() }).optional(),
    rank: z.number().optional(),
    code: z.union([z.string(), z.number()]).optional(),
  }),
});
const OptionalPodcast = defineNode("TsOptionalPodcast", {
  schema: z.object({
    title: z.string(),
    rssUrl: z.string(),
    code: z.string().optional(),
  }),
});

const optionalFieldGraph = defineGraph({
  id: "typed_subsumption_optional_field_integration",
  nodes: {
    TsOptionalMedia: { type: OptionalMedia },
    TsOptionalPodcast: { type: OptionalPodcast },
  },
  edges: {},
  ontology: [subClassOf(OptionalPodcast, OptionalMedia)],
});

// The parent declares the only `searchable()` field; the subclass redeclares
// `title` as a plain string, which is the same structural type.
const SearchableDocument = defineNode("TsSearchableDoc", {
  schema: z.object({ title: searchable({ language: "english" }) }),
});
const PlainMemo = defineNode("TsPlainMemo", {
  schema: z.object({ title: z.string(), note: z.string() }),
});

const parentSearchableGraph = defineGraph({
  id: "typed_subsumption_parent_searchable_integration",
  nodes: {
    TsSearchableDoc: { type: SearchableDocument },
    TsPlainMemo: { type: PlainMemo },
  },
  edges: {},
  ontology: [subClassOf(PlainMemo, SearchableDocument)],
});

async function seedOptionalFieldStore(context: IntegrationTestContext) {
  const store = await context.createStore(optionalFieldGraph);
  await store.nodes.TsOptionalMedia.create({
    title: "alpha",
    tags: ["a", "b"],
    featured: true,
    info: { lang: "en" },
    rank: 3,
    code: "c",
  });
  await store.nodes.TsOptionalMedia.create({
    title: "bravo",
    featured: false,
    rank: 1,
    code: "a",
  });
  await store.nodes.TsOptionalPodcast.create({
    title: "charlie",
    rssUrl: "https://x",
    code: "b",
  });
  return store;
}

export function registerOntologyTypedSubsumptionIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Typed subsumption — polymorphic default", () => {
    it("returns subtype rows by default and only exact rows when narrowed", async () => {
      const store = await context.createStore(subsumptionGraph);
      await store.nodes.TsMedia.create({ title: "plain" });
      await store.nodes.TsPodcast.create({
        title: "cast",
        rssUrl: "https://x",
      });

      const polymorphic = await store
        .query()
        .from("TsMedia", "m")
        .select((ctx) => ctx.m)
        .execute();
      expect(polymorphic.map((row) => row.kind).toSorted()).toEqual([
        "TsMedia",
        "TsPodcast",
      ]);

      const exact = await store
        .query()
        .from("TsMedia", "m", { expansion: "exact" })
        .select((ctx) => ctx.m)
        .execute();
      expect(exact.map((row) => row.kind)).toEqual(["TsMedia"]);
    });

    // Mutation-checked: flipping the store's default
    // `queryDefaults.expansion` from `"subclasses"` to `"exact"` drops the
    // `TsPodcast` row and fails this assertion on BOTH engines; restored.
    it("returns identical row ordering under an explicit orderBy on both engines", async () => {
      const store = await context.createStore(subsumptionGraph);
      await store.nodes.TsMedia.create({ title: "bravo" });
      await store.nodes.TsPodcast.create({
        title: "alpha",
        rssUrl: "https://x",
      });
      await store.nodes.TsMedia.create({ title: "charlie" });

      const rows = await store
        .query()
        .from("TsMedia", "m")
        .orderBy("m", "title", "asc")
        .select((ctx) => ctx.m)
        .execute();

      expect(rows.map((row) => row.title)).toEqual([
        "alpha",
        "bravo",
        "charlie",
      ]);
    });

    // NOT mutation-checked on the "exact" half: `backend.fulltextSearch({
    // nodeKind, ... })` already scopes the physical search to the exact
    // kind regardless of what the candidate subquery's `from()` widens to
    // (src/store/search.ts's module docblock), so dropping its
    // `{ expansion: "exact" }` pin leaves that assertion green on
    // BOTH engines — same defense-in-depth shape the SQLite-only pin in
    // tests/polymorphic-default.test.ts documents. This is cross-backend
    // PARITY coverage (AGENTS.md "Backend parity": the candidate
    // subquery composes with FTS5 on SQLite and tsvector on PostgreSQL, so
    // only running the case on both engines can prove they agree), not an
    // independent load-bearing guard.
    it(`fulltext search's candidate subquery stays exact-kind by default and expands with expansion: "subclasses", on both engines`, async (ctx) => {
      const store = await context.createStore(searchGraph);
      if (store.backend.capabilities.fulltext?.supported !== true) {
        ctx.skip();
      }

      await store.nodes.TsSearchMedia.create({
        title: "unique_ts_fulltext_marker media",
      });
      await store.nodes.TsSearchPodcast.create({
        title: "unique_ts_fulltext_marker podcast",
        rssUrl: "https://x",
      });

      const exact = await store.search.fulltext("TsSearchMedia", {
        query: "unique_ts_fulltext_marker",
        limit: 10,
      });
      expect(exact.map((result) => result.node.kind)).toEqual([
        "TsSearchMedia",
      ]);

      const expanded = await store.search.fulltext("TsSearchMedia", {
        query: "unique_ts_fulltext_marker",
        limit: 10,
        expansion: "subclasses",
      });
      expect(expanded.map((result) => result.node.kind).toSorted()).toEqual(
        SEARCH_KINDS,
      );
    });

    it(`vector search stays exact-kind by default and returns the subclass row with expansion: "subclasses", on both engines`, async (ctx) => {
      const store = await context.createStore(searchGraph);
      if (store.backend.capabilities.vector?.supported !== true) {
        ctx.skip();
      }

      await store.nodes.TsSearchMedia.create({
        title: "vector media",
        embedding: SEARCH_QUERY_EMBEDDING,
      });
      await store.nodes.TsSearchPodcast.create({
        title: "vector podcast",
        embedding: SEARCH_QUERY_EMBEDDING,
        rssUrl: "https://x",
      });

      const exact = await store.search.vector("TsSearchMedia", {
        fieldPath: "embedding",
        queryEmbedding: SEARCH_QUERY_EMBEDDING,
        limit: 10,
      });
      expect(exact.map((result) => result.node.kind)).toEqual([
        "TsSearchMedia",
      ]);

      const expanded = await store.search.vector("TsSearchMedia", {
        fieldPath: "embedding",
        queryEmbedding: SEARCH_QUERY_EMBEDDING,
        limit: 10,
        expansion: "subclasses",
      });
      expect(expanded.map((result) => result.node.kind).toSorted()).toEqual(
        SEARCH_KINDS,
      );
    });

    it(`hybrid search stays exact-kind by default and returns the subclass row with expansion: "subclasses", on both engines`, async (ctx) => {
      const store = await context.createStore(searchGraph);
      if (
        store.backend.capabilities.fulltext?.supported !== true ||
        store.backend.capabilities.vector?.supported !== true
      ) {
        ctx.skip();
      }

      await store.nodes.TsSearchMedia.create({
        title: "unique_ts_hybrid_marker media",
        embedding: SEARCH_QUERY_EMBEDDING,
      });
      await store.nodes.TsSearchPodcast.create({
        title: "unique_ts_hybrid_marker podcast",
        embedding: SEARCH_QUERY_EMBEDDING,
        rssUrl: "https://x",
      });

      const exact = await store.search.hybrid("TsSearchMedia", {
        vector: {
          fieldPath: "embedding",
          queryEmbedding: SEARCH_QUERY_EMBEDDING,
        },
        fulltext: { query: "unique_ts_hybrid_marker" },
        limit: 10,
      });
      expect(exact.map((result) => result.node.kind)).toEqual([
        "TsSearchMedia",
      ]);

      const expanded = await store.search.hybrid("TsSearchMedia", {
        vector: {
          fieldPath: "embedding",
          queryEmbedding: SEARCH_QUERY_EMBEDDING,
        },
        fulltext: { query: "unique_ts_hybrid_marker" },
        limit: 10,
        expansion: "subclasses",
      });
      expect(expanded.map((result) => result.node.kind).toSorted()).toEqual(
        SEARCH_KINDS,
      );
      // Both legs found the subclass row, not only the fused union.
      const podcast = expanded.find(
        (result) => result.node.kind === "TsSearchPodcast",
      );
      expect(podcast?.vector?.node.kind).toBe("TsSearchPodcast");
      expect(podcast?.fulltext?.node.kind).toBe("TsSearchPodcast");
    });

    // NOT mutation-checked: the outer `WHERE nodes.kind = <kind>` in
    // `executeNodeSetUpdate` re-filters the candidate set to `TsMedia`
    // regardless of what this root's `fromDynamic` pin (node-collection.ts)
    // widens to — same defense-in-depth shape the SQLite-only pin in
    // tests/polymorphic-default.test.ts documents. Cross-backend PARITY
    // coverage: the outer fence's SQL differs by dialect, so only running
    // the case on both engines proves neither one's fence lets a
    // `TsPodcast` row through.
    it("updateWhere on the parent kind leaves subtype rows untouched, on both engines", async () => {
      const store = await context.createStore(subsumptionGraph);
      await store.nodes.TsMedia.create({ title: "before" });
      const podcast = await store.nodes.TsPodcast.create({
        title: "before",
        rssUrl: "https://x",
      });

      const result = await store.nodes.TsMedia.updateWhere({
        all: true,
        patch: { title: "after" },
      });

      expect(result.affectedCount).toBe(1);
      const stillPodcast = await store.nodes.TsPodcast.getById(podcast.id);
      expect(stillPodcast?.title).toBe("before");
    });
  });

  describe("Typed subsumption — parent properties a subclass omits", () => {
    it("decodes a field-level select as the parent's property types", async () => {
      const store = await seedOptionalFieldStore(context);

      const exact = await store
        .query()
        .from("TsOptionalMedia", "m", { expansion: "exact" })
        .orderBy("m", "title", "asc")
        .select((ctx) => ({
          title: ctx.m.title,
          tags: ctx.m.tags,
          featured: ctx.m.featured,
          info: ctx.m.info,
          rank: ctx.m.rank,
        }))
        .execute();
      const polymorphic = await store
        .query()
        .from("TsOptionalMedia", "m")
        .orderBy("m", "title", "asc")
        .select((ctx) => ({
          title: ctx.m.title,
          tags: ctx.m.tags,
          featured: ctx.m.featured,
          info: ctx.m.info,
          rank: ctx.m.rank,
        }))
        .execute();

      expect(exact[0]).toEqual({
        title: "alpha",
        tags: ["a", "b"],
        featured: true,
        info: { lang: "en" },
        rank: 3,
      });
      expect(polymorphic.slice(0, 2)).toEqual(exact);
      expect(polymorphic[2]?.title).toBe("charlie");
      expect(polymorphic[2]?.tags ?? undefined).toBeUndefined();
      expect(polymorphic[2]?.featured ?? undefined).toBeUndefined();
      expect(polymorphic[2]?.info ?? undefined).toBeUndefined();
    });

    it("filters, orders and groups by a parent property a subclass omits or narrows", async () => {
      const store = await seedOptionalFieldStore(context);

      const filtered = await store
        .query()
        .from("TsOptionalMedia", "m")
        .whereNode("m", (m) => m.rank.gt(1))
        .select((ctx) => ctx.m.title)
        .execute();
      expect(filtered).toEqual(["alpha"]);

      const byRank = await store
        .query()
        .from("TsOptionalMedia", "m")
        .whereNode("m", (m) => m.rank.isNotNull())
        .orderBy("m", "rank", "asc")
        .select((ctx) => ctx.m.title)
        .execute();
      expect(byRank).toEqual(["bravo", "alpha"]);

      const byCode = await store
        .query()
        .from("TsOptionalMedia", "m")
        .orderBy("m", "code", "asc")
        .select((ctx) => ctx.m.title)
        .execute();
      expect(byCode).toEqual(["bravo", "charlie", "alpha"]);

      const grouped = await store
        .query()
        .from("TsOptionalMedia", "m")
        .groupBy("m", "featured")
        .aggregate({ featured: field("m", "featured"), total: count("m") })
        .execute();
      expect(grouped).toHaveLength(3);
      expect(grouped.find((row) => row.featured === true)?.total).toBe(1);
      expect(grouped.find((row) => row.featured === false)?.total).toBe(1);
    });

    it("still refuses a property only the subclass declares", async () => {
      const store = await context.createStore(optionalFieldGraph);

      expect(() =>
        store
          .query()
          .from("TsOptionalMedia", "m")
          .orderBy("m", "rssUrl", "asc"),
      ).toThrow(ConfigurationError);
    });

    it("runs $fulltext.matches() when only the parent kind declares searchable content", async (ctx) => {
      const store = await context.createStore(parentSearchableGraph);
      if (store.backend.capabilities.fulltext?.supported !== true) {
        ctx.skip();
      }

      const document = await store.nodes.TsSearchableDoc.create({
        title: "unique_ts_parent_marker climate",
      });
      await store.nodes.TsPlainMemo.create({
        title: "unique_ts_parent_marker climate",
        note: "not indexed",
      });

      const matches = await store
        .query()
        .from("TsSearchableDoc", "d")
        .whereNode("d", (d) => d.$fulltext.matches("unique_ts_parent_marker"))
        .select((selection) => ({
          id: selection.d.id,
          kind: selection.d.kind,
        }))
        .execute();

      expect(matches).toEqual([{ id: document.id, kind: "TsSearchableDoc" }]);
    });
  });

  describe("narrower expansion over a kind taxonomy", () => {
    it("from() expands through a three-level broader/narrower chain", async () => {
      const store = await context.createStore(narrowerGraph);
      await store.nodes.TsRootConcept.create({ name: "root" });
      await store.nodes.TsMidConcept.create({ name: "mid" });
      await store.nodes.TsLeafConcept.create({ name: "leaf" });

      const rows = await store
        .query()
        .from("TsRootConcept", "c", { expansion: "narrower" })
        .select((ctx) => ctx.c)
        .execute();

      expect(rows.map((row) => row.kind).toSorted()).toEqual([
        "TsLeafConcept",
        "TsMidConcept",
        "TsRootConcept",
      ]);
    });

    it("to() expands through the same chain, composing with a predicate and limit", async () => {
      const store = await context.createStore(narrowerGraph);
      const root = await store.nodes.TsRootConcept.create({ name: "root" });
      const mid = await store.nodes.TsMidConcept.create({ name: "mid" });
      const leaf = await store.nodes.TsLeafConcept.create({ name: "leaf" });
      await store.edges.tsConceptLink.create(root, root, {});
      await store.edges.tsConceptLink.create(root, mid, {});
      await store.edges.tsConceptLink.create(root, leaf, {});

      const rows = await store
        .query()
        .from("TsRootConcept", "root")
        .whereNode("root", (accessor) => accessor.id.eq(root.id))
        .traverse("tsConceptLink", "e")
        .to("TsRootConcept", "target", { expansion: "narrower" })
        .select((ctx) => ctx.target)
        .execute();

      expect(rows.map((row) => row.kind).toSorted()).toEqual([
        "TsLeafConcept",
        "TsMidConcept",
        "TsRootConcept",
      ]);
    });

    it("refuses a narrower expansion naming an unregistered kind, identically on both engines", async () => {
      // `broader`/`narrower` accept any NodeType, registered or not — the
      // concept node is never added to `unregisteredNarrowerGraph.nodes`.
      const UnregisteredLeaf = defineNode("TsUnregisteredLeaf", {
        schema: z.object({ name: z.string() }),
      });
      const unregisteredNarrowerGraph = defineGraph({
        id: "typed_narrower_unregistered_integration",
        nodes: { TsRootConcept: { type: RootConcept } },
        edges: {},
        ontology: [broader(UnregisteredLeaf, RootConcept)],
      });
      const store = await context.createStore(unregisteredNarrowerGraph);

      let caught: unknown;
      try {
        store.query().from("TsRootConcept", "c", { expansion: "narrower" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigurationError);
      expect((caught as ConfigurationError).details["code"]).toBe(
        "ONTOLOGY_NARROWER_KIND_NOT_REGISTERED",
      );
    });

    it("refuses a narrower expansion whose kinds are not admitted edge endpoints, identically on both engines", async () => {
      // tsConceptLinkNarrow admits ONLY TsRootConcept as a `to` endpoint —
      // the narrower expansion (Mid, Leaf) is not an assignability
      // axis, so those two kinds are never automatically admitted the way
      // subClassOf descendants are.
      const store = await context.createStore(narrowerGraph);
      const root = await store.nodes.TsRootConcept.create({ name: "root" });

      let caught: unknown;
      try {
        store
          .query()
          .from("TsRootConcept", "root")
          .whereNode("root", (accessor) => accessor.id.eq(root.id))
          .traverse("tsConceptLinkNarrow", "e")
          .to("TsRootConcept", "target", { expansion: "narrower" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigurationError);
      expect((caught as ConfigurationError).details["code"]).toBe(
        "ONTOLOGY_NARROWER_ENDPOINT_NOT_ADMITTED",
      );
    });

    it("refuses the same narrower expansion when the edge's endpoints are declared on the graph registration", async () => {
      const store = await context.createStore(narrowerGraph);
      const traversal = () =>
        store
          .query()
          .from("TsRootConcept", "root")
          .traverse("tsConceptLinkGraphNarrow", "e");
      const attempts: Record<string, () => unknown> = {
        to: () =>
          traversal().to("TsRootConcept", "target", { expansion: "narrower" }),
        toDynamic: () =>
          traversal().toDynamic("TsRootConcept", "target", {
            expansion: "narrower",
          }),
      };

      const refusals = Object.fromEntries(
        Object.entries(attempts).map(([name, attempt]) => {
          try {
            attempt();
            return [name, "accepted"];
          } catch (error) {
            return [
              name,
              error instanceof ConfigurationError ?
                error.details["code"]
              : error,
            ];
          }
        }),
      );

      expect(refusals).toEqual({
        to: "ONTOLOGY_NARROWER_ENDPOINT_NOT_ADMITTED",
        toDynamic: "ONTOLOGY_NARROWER_ENDPOINT_NOT_ADMITTED",
      });
    });

    it("refuses a toDynamic target the graph registration does not admit, and accepts one it does", async () => {
      const store = await context.createStore(narrowerGraph);
      const traversal = () =>
        store
          .query()
          .from("TsRootConcept", "root")
          .traverse("tsConceptLinkGraphNarrow", "e");

      expect(() =>
        traversal().toDynamic("TsLeafConcept", "target", {
          expansion: "exact",
        }),
      ).toThrow(EndpointError);

      const root = await store.nodes.TsRootConcept.create({ name: "root" });
      const other = await store.nodes.TsRootConcept.create({ name: "other" });
      await store.edges.tsConceptLinkGraphNarrow.create(root, other, {});
      const rows = await traversal()
        .toDynamic("TsRootConcept", "target", { expansion: "exact" })
        .select((ctx) => ({ id: ctx.target.id }))
        .execute();
      expect(rows).toEqual([{ id: other.id }]);
    });
  });
}
