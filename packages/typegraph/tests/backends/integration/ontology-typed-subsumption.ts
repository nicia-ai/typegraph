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
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineGraphExtension,
  defineNode,
  embedding,
  field,
  searchable,
  subClassOf,
} from "../../../src";
import {
  ConfigurationError,
  EndpointError,
  KindNotFoundError,
  UnsupportedPredicateError,
} from "../../../src/errors";
import { requireDefined } from "../../../src/utils/presence";
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

// The parent declares the only `searchable()` and `embedding()` fields, both
// optional. The structural contract does not see either annotation, so a
// subclass may omit the field (it holds no such content) or redeclare it as a
// plain string / number array (it holds content the parent's index never
// reaches).
const SearchableDocument = defineNode("TsSearchableDoc", {
  schema: z.object({
    title: searchable({ language: "english" }).optional(),
    vector: embedding(3).optional(),
  }),
});
const TitlelessMemo = defineNode("TsTitlelessMemo", {
  schema: z.object({ note: z.string() }),
});
const RedeclaredTitleMemo = defineNode("TsRedeclaredTitleMemo", {
  schema: z.object({ title: z.string().optional(), note: z.string() }),
});
const RedeclaredVectorMemo = defineNode("TsRedeclaredVectorMemo", {
  schema: z.object({ vector: z.array(z.number()).optional() }),
});

const omittedSearchableGraph = defineGraph({
  id: "typed_subsumption_omitted_searchable_integration",
  nodes: {
    TsSearchableDoc: { type: SearchableDocument },
    TsTitlelessMemo: { type: TitlelessMemo },
  },
  edges: {},
  ontology: [subClassOf(TitlelessMemo, SearchableDocument)],
});

const redeclaredTitleGraph = defineGraph({
  id: "typed_subsumption_redeclared_title_integration",
  nodes: {
    TsSearchableDoc: { type: SearchableDocument },
    TsRedeclaredTitleMemo: { type: RedeclaredTitleMemo },
  },
  edges: {},
  ontology: [subClassOf(RedeclaredTitleMemo, SearchableDocument)],
});

const redeclaredVectorGraph = defineGraph({
  id: "typed_subsumption_redeclared_vector_integration",
  nodes: {
    TsSearchableDoc: { type: SearchableDocument },
    TsRedeclaredVectorMemo: { type: RedeclaredVectorMemo },
  },
  edges: {},
  ontology: [
    // The compile-time filter reads the branded `EmbeddingValue`; the registry
    // build, which compares projected JSON Schema, accepts the plain array.
    // @ts-expect-error a plain number array is not the branded embedding type
    subClassOf(RedeclaredVectorMemo, SearchableDocument),
  ],
});

// The reverse divergence: the parent declares the vector field as a plain
// number array and the subclass tags it embedding(), so the subclass's rows are
// indexed and the parent's are not.
const PlainVectorDocument = defineNode("TsPlainVectorDoc", {
  schema: z.object({ vector: z.array(z.number()).optional() }),
});
const TaggedVectorMemo = defineNode("TsTaggedVectorMemo", {
  schema: z.object({ vector: embedding(3).optional() }),
});
const taggedSubclassGraph = defineGraph({
  id: "typed_subsumption_tagged_subclass_integration",
  nodes: {
    TsPlainVectorDoc: { type: PlainVectorDocument },
    TsTaggedVectorMemo: { type: TaggedVectorMemo },
  },
  edges: {},
  ontology: [
    // The compile-time filter reads the branded `EmbeddingValue` on the child
    // against the plain array on the parent; the registry accepts it.
    // @ts-expect-error a branded embedding is not a plain number array to the filter
    subClassOf(TaggedVectorMemo, PlainVectorDocument),
  ],
});

// List sources: two unrelated listed kinds, one of which has a subclass that
// omits the parent-optional `rank` both listed kinds declare.
const ListMedia = defineNode("TsListMedia", {
  schema: z.object({ title: z.string(), rank: z.number().optional() }),
});
const ListPodcast = defineNode("TsListPodcast", {
  schema: z.object({ title: z.string(), rssUrl: z.string() }),
});
const ListCompany = defineNode("TsListCompany", {
  schema: z.object({ title: z.string(), rank: z.number().optional() }),
});
const LIST_KINDS = ["TsListCompany", "TsListMedia"] as const;

const listSourceGraph = defineGraph({
  id: "typed_subsumption_list_source_integration",
  nodes: {
    TsListMedia: { type: ListMedia },
    TsListPodcast: { type: ListPodcast },
    TsListCompany: { type: ListCompany },
  },
  edges: {},
  ontology: [subClassOf(ListPodcast, ListMedia)],
});

async function seedListSourceStore(
  context: IntegrationTestContext,
  options?: Parameters<IntegrationTestContext["createStore"]>[1],
) {
  const store = await context.createStore(listSourceGraph, options);
  await store.nodes.TsListMedia.create({ title: "media", rank: 2 });
  await store.nodes.TsListPodcast.create({
    title: "podcast",
    rssUrl: "https://x",
  });
  await store.nodes.TsListCompany.create({ title: "company", rank: 1 });
  return store;
}

// A compile-time kind with no subclass in the compile-time graph, which a
// persisted extension then subclasses.
const RuntimeSubclassDocument = defineNode("TsRuntimeDoc", {
  schema: z.object({ title: searchable({ language: "english" }) }),
});
const RuntimeSubclassOwner = defineNode("TsRuntimeOwner", {
  schema: z.object({ name: z.string() }),
});
const runtimeSubclassOwns = defineEdge("tsRuntimeOwns", {
  schema: z.object({}),
});
const runtimeSubclassGraph = defineGraph({
  id: "typed_subsumption_runtime_subclass_integration",
  nodes: {
    TsRuntimeDoc: { type: RuntimeSubclassDocument },
    TsRuntimeOwner: { type: RuntimeSubclassOwner },
  },
  edges: {
    tsRuntimeOwns: {
      type: runtimeSubclassOwns,
      from: [RuntimeSubclassOwner],
      to: [RuntimeSubclassDocument],
    },
  },
});
const runtimeSubclassExtension = defineGraphExtension({
  nodes: {
    TsRuntimeMemo: {
      properties: {
        title: { type: "string", searchable: { language: "english" } },
      },
    },
  },
  ontology: [
    { metaEdge: "subClassOf", from: "TsRuntimeMemo", to: "TsRuntimeDoc" },
  ],
});
const UNTYPED_SUBCLASSES_CODE = "QUERY_ALIAS_EXPANSION_UNTYPED_SUBCLASSES";

async function expectRefusedAndStatedAxesAnswered(
  store: Awaited<
    ReturnType<typeof createStoreWithSchema<typeof runtimeSubclassGraph>>
  >[0],
): Promise<void> {
  expectUntypedSubclassRefusal(
    await rejectionOf(
      Promise.resolve().then(() => store.query().from("TsRuntimeDoc", "d")),
    ),
    ["from()", "fromDynamic()"],
  );
  expectUntypedSubclassRefusal(
    await rejectionOf(
      Promise.resolve().then(() => store.query().from(["TsRuntimeDoc"], "d")),
    ),
    ["from()", "fromDynamic()"],
  );
  expectUntypedSubclassRefusal(
    await rejectionOf(
      Promise.resolve().then(() =>
        store
          .query()
          .from("TsRuntimeOwner", "o")
          .traverse("tsRuntimeOwns", "e")
          .to("TsRuntimeDoc", "d"),
      ),
    ),
    ["to()", "toDynamic()"],
  );

  // A stated "subclasses" search hit is typed polymorphically whatever the
  // compile-time graph declares, so the extension's subclass is answered.
  const searchHits = await store.search.fulltext("TsRuntimeDoc", {
    query: "runtime",
    limit: 10,
    expansion: "subclasses",
  });
  expect(kindsOf(searchHits.map((hit) => hit.node))).toEqual([
    "TsRuntimeDoc",
    "TsRuntimeMemo",
  ]);
  const searchedKind = "TsRuntimeDoc";
  const stringKindHits = await store.search.fulltext(searchedKind, {
    query: "runtime",
    limit: 10,
    expansion: "subclasses",
  });
  expect(kindsOf(stringKindHits.map((hit) => hit.node))).toEqual([
    "TsRuntimeDoc",
    "TsRuntimeMemo",
  ]);

  expect(
    kindsOf(
      await store
        .query()
        .from("TsRuntimeDoc", "d", { expansion: "subclasses" })
        .select((ctx) => ctx.d)
        .execute(),
    ),
  ).toEqual(["TsRuntimeDoc", "TsRuntimeMemo"]);
  expect(
    kindsOf(
      await store
        .query()
        .from("TsRuntimeDoc", "d", { expansion: "exact" })
        .select((ctx) => ctx.d)
        .execute(),
    ),
  ).toEqual(["TsRuntimeDoc"]);
  expect(
    kindsOf(
      await store
        .query()
        .fromDynamic("TsRuntimeDoc", "d")
        .select((ctx) => ctx.d)
        .execute(),
    ),
  ).toEqual(["TsRuntimeDoc", "TsRuntimeMemo"]);
}

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

const UNINDEXED_SEARCH_CODE = "SEARCH_EXPANSION_KIND_UNINDEXED";

/** The error an awaited attempt rejects with, or `undefined` if it resolved. */
async function rejectionOf(attempt: Promise<unknown>): Promise<unknown> {
  try {
    await attempt;
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectConfigurationError(caught: unknown): ConfigurationError {
  expect(caught).toBeInstanceOf(ConfigurationError);
  return caught as ConfigurationError;
}

function kindsOf(rows: readonly Readonly<{ kind: string }>[]): string[] {
  return rows.map((row) => row.kind).toSorted();
}

function expectUntypedSubclassRefusal(
  caught: unknown,
  suggestedSurfaces: readonly string[],
): void {
  const error = expectConfigurationError(caught);
  expect(error.details).toMatchObject({
    code: UNTYPED_SUBCLASSES_CODE,
    kind: "TsRuntimeDoc",
    extraKinds: ["TsRuntimeMemo"],
  });
  for (const surface of suggestedSurfaces) {
    expect(error.suggestion).toContain(surface);
  }
}

// Four compile-time kinds; only TsCoverTopic is polymorphic at compile time.
// A persisted extension then declares TsCoverNote and TsCoverTag subclasses
// of TsCoverDoc, and TsCoverTag a subclass of TsCoverTopic too.
const CoverDocument = defineNode("TsCoverDoc", {
  schema: z.object({ title: z.string() }),
});
const CoverNote = defineNode("TsCoverNote", {
  schema: z.object({ title: z.string() }),
});
const CoverTopic = defineNode("TsCoverTopic", {
  schema: z.object({ title: z.string() }),
});
const CoverTag = defineNode("TsCoverTag", {
  schema: z.object({ title: z.string() }),
});
const listCoverageGraph = defineGraph({
  id: "typed_subsumption_list_coverage_integration",
  nodes: {
    TsCoverDoc: { type: CoverDocument },
    TsCoverNote: { type: CoverNote },
    TsCoverTopic: { type: CoverTopic },
    TsCoverTag: { type: CoverTag },
  },
  edges: {},
  ontology: [subClassOf(CoverNote, CoverTopic)],
});
const listCoverageExtension = defineGraphExtension({
  ontology: [
    { metaEdge: "subClassOf", from: "TsCoverNote", to: "TsCoverDoc" },
    { metaEdge: "subClassOf", from: "TsCoverTag", to: "TsCoverDoc" },
    { metaEdge: "subClassOf", from: "TsCoverTag", to: "TsCoverTopic" },
  ],
});

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

  describe("Typed subsumption — subclass endpoints on typed edge collections", () => {
    it("connects a polymorphic row without a cast and resolves its endpoint by reference", async () => {
      const store = await context.createStore(subsumptionGraph);
      const media = await store.nodes.TsMedia.create({ title: "plain" });
      const podcast = await store.nodes.TsPodcast.create({
        title: "cast",
        rssUrl: "https://x",
      });
      const rows = await store
        .query()
        .from("TsMedia", "m")
        .whereNode("m", (m) => m.title.eq("cast"))
        .select((ctx) => ctx.m)
        .execute();
      const podcastRow = requireDefined(rows[0]);
      expect(podcastRow.kind).toBe("TsPodcast");

      await store.edges.tsLinksTo.create(media, podcastRow);
      const links = await store.edges.tsLinksTo.findFrom(media);
      const link = requireDefined(links[0]);
      expect(link.toKind).toBe("TsPodcast");

      const reference = { kind: link.toKind, id: link.toId };
      const resolved = await store.getNodeByRef(reference);
      expect(resolved).toMatchObject({
        kind: "TsPodcast",
        id: podcast.id,
        rssUrl: "https://x",
      });
      const inTransaction = await store.transaction((tx) =>
        tx.getNodeByRef(reference),
      );
      expect(inTransaction?.id).toBe(podcast.id);
      const inView = await store.snapshot().getNodeByRef(reference);
      expect(inView?.id).toBe(podcast.id);

      const supertypeNamed = await store.getNodeByRef({
        kind: "TsMedia",
        id: podcast.id,
      });
      expect(supertypeNamed).toBeUndefined();
      await expect(
        store.getNodeByRef({ kind: "TsUnregistered", id: podcast.id }),
      ).rejects.toBeInstanceOf(KindNotFoundError);
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

    it("runs $fulltext.matches() when the subclass omits the parent's searchable field", async (ctx) => {
      const store = await context.createStore(omittedSearchableGraph);
      if (store.backend.capabilities.fulltext?.supported !== true) {
        ctx.skip();
      }

      const document = await store.nodes.TsSearchableDoc.create({
        title: "unique_ts_parent_marker climate",
      });
      await store.nodes.TsTitlelessMemo.create({
        note: "unique_ts_parent_marker climate",
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

    it("refuses $fulltext.matches() when a subclass redeclares the searchable field untagged", async () => {
      const store = await context.createStore(redeclaredTitleGraph);

      let caught: unknown;
      try {
        store
          .query()
          .from("TsSearchableDoc", "d")
          .whereNode("d", (d) => d.$fulltext.matches("anything"));
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(UnsupportedPredicateError);
      expect((caught as Error).message).toContain(
        'kind "TsRedeclaredTitleMemo"',
      );

      await store.nodes.TsSearchableDoc.create({ title: "alpha" });
      await store.nodes.TsRedeclaredTitleMemo.create({
        title: "alpha",
        note: "n",
      });
      const byTitle = await store
        .query()
        .from("TsSearchableDoc", "d")
        .whereNode("d", (d) => d.title.eq("alpha"))
        .select((selection) => selection.d.kind)
        .execute();
      expect(byTitle.toSorted()).toEqual([
        "TsRedeclaredTitleMemo",
        "TsSearchableDoc",
      ]);
    });

    it("refuses an embedding accessor when a subclass redeclares the vector field untagged", async () => {
      const store = await context.createStore(redeclaredVectorGraph);

      expect(() =>
        store
          .query()
          .from("TsSearchableDoc", "d")
          .whereNode("d", (d) => d.vector.similarTo([1, 0, 0], 5)),
      ).toThrow(ConfigurationError);
    });
  });

  describe("Typed subsumption — search facade over kinds an index would miss", () => {
    it(`refuses a fulltext expansion when a subclass redeclares the searchable field untagged, as the builder does`, async (ctx) => {
      const store = await context.createStore(redeclaredTitleGraph);
      if (store.backend.capabilities.fulltext?.supported !== true) {
        ctx.skip();
      }
      await store.nodes.TsSearchableDoc.create({
        title: "unique_ts_gap_marker",
      });
      await store.nodes.TsRedeclaredTitleMemo.create({
        title: "unique_ts_gap_marker",
        note: "n",
      });

      const exact = await store.search.fulltext("TsSearchableDoc", {
        query: "unique_ts_gap_marker",
        limit: 10,
      });
      expect(exact.map((hit) => hit.node.kind)).toEqual(["TsSearchableDoc"]);

      const refusal = expectConfigurationError(
        await rejectionOf(
          store.search.fulltext("TsSearchableDoc", {
            query: "unique_ts_gap_marker",
            limit: 10,
            expansion: "subclasses",
          }),
        ),
      );
      expect(refusal.details).toMatchObject({
        code: UNINDEXED_SEARCH_CODE,
        capability: "fulltext",
        kinds: ["TsRedeclaredTitleMemo"],
      });
      expect(refusal.message).toContain('"TsRedeclaredTitleMemo"');
    });

    it(`refuses the fulltext leg of a hybrid expansion over the same kinds`, async (ctx) => {
      const store = await context.createStore(redeclaredTitleGraph);
      if (
        store.backend.capabilities.fulltext?.supported !== true ||
        store.backend.capabilities.vector?.supported !== true
      ) {
        ctx.skip();
      }

      const refusal = expectConfigurationError(
        await rejectionOf(
          store.search.hybrid("TsSearchableDoc", {
            vector: { fieldPath: "vector", queryEmbedding: [1, 0, 0] },
            fulltext: { query: "anything" },
            limit: 10,
            expansion: "subclasses",
          }),
        ),
      );
      expect(refusal.details).toMatchObject({
        code: UNINDEXED_SEARCH_CODE,
        capability: "fulltext",
      });
    });

    it(`refuses a vector expansion when a subclass redeclares the embedding field untagged`, async (ctx) => {
      const store = await context.createStore(redeclaredVectorGraph);
      if (store.backend.capabilities.vector?.supported !== true) {
        ctx.skip();
      }
      await store.nodes.TsSearchableDoc.create({ vector: [1, 0, 0] });
      await store.nodes.TsRedeclaredVectorMemo.create({ vector: [1, 0, 0] });

      const exact = await store.search.vector("TsSearchableDoc", {
        fieldPath: "vector",
        queryEmbedding: [1, 0, 0],
        limit: 10,
      });
      expect(exact.map((hit) => hit.node.kind)).toEqual(["TsSearchableDoc"]);

      const refusal = expectConfigurationError(
        await rejectionOf(
          store.search.vector("TsSearchableDoc", {
            fieldPath: "vector",
            queryEmbedding: [1, 0, 0],
            limit: 10,
            expansion: "subclasses",
          }),
        ),
      );
      expect(refusal.details).toMatchObject({
        code: UNINDEXED_SEARCH_CODE,
        capability: "vector",
        kinds: ["TsRedeclaredVectorMemo"],
      });
    });

    it(`refuses an exact fulltext search of a kind the builder refuses, rather than returning nothing`, async (ctx) => {
      const store = await context.createStore(redeclaredTitleGraph);
      if (store.backend.capabilities.fulltext?.supported !== true) {
        ctx.skip();
      }
      await store.nodes.TsRedeclaredTitleMemo.create({
        title: "unique_ts_exact_marker",
        note: "n",
      });

      expect(() =>
        store
          .query()
          .from("TsRedeclaredTitleMemo", "m", { expansion: "exact" })
          .whereNode("m", (m) => m.$fulltext.matches("unique_ts_exact_marker")),
      ).toThrow(UnsupportedPredicateError);

      const refusal = expectConfigurationError(
        await rejectionOf(
          store.search.fulltext("TsRedeclaredTitleMemo", {
            query: "unique_ts_exact_marker",
            limit: 10,
          }),
        ),
      );
      expect(refusal.details).toMatchObject({
        code: UNINDEXED_SEARCH_CODE,
        capability: "fulltext",
        kinds: ["TsRedeclaredTitleMemo"],
      });
    });

    it(`refuses an exact fulltext search of a kind with no searchable field, in a hybrid leg too`, async (ctx) => {
      const store = await context.createStore(omittedSearchableGraph);
      if (
        store.backend.capabilities.fulltext?.supported !== true ||
        store.backend.capabilities.vector?.supported !== true
      ) {
        ctx.skip();
      }

      const fulltextRefusal = expectConfigurationError(
        await rejectionOf(
          store.search.fulltext("TsTitlelessMemo", {
            query: "anything",
            limit: 10,
          }),
        ),
      );
      expect(fulltextRefusal.details).toMatchObject({
        code: UNINDEXED_SEARCH_CODE,
        capability: "fulltext",
        kinds: ["TsTitlelessMemo"],
      });

      const hybridRefusal = expectConfigurationError(
        await rejectionOf(
          store.search.hybrid("TsTitlelessMemo", {
            vector: { fieldPath: "vector", queryEmbedding: [1, 0, 0] },
            fulltext: { query: "anything" },
            limit: 10,
          }),
        ),
      );
      expect(hybridRefusal.details).toMatchObject({
        code: UNINDEXED_SEARCH_CODE,
        capability: "fulltext",
      });
    });

    it(`refuses a vector expansion whose subclass tags a field the parent declares plain, as the builder does`, async (ctx) => {
      const store = await context.createStore(taggedSubclassGraph);
      if (store.backend.capabilities.vector?.supported !== true) {
        ctx.skip();
      }

      expect(() =>
        store
          .query()
          .from("TsPlainVectorDoc", "d")
          .whereNode("d", (d) =>
            // The parent declares a plain array, so the typed accessor has no
            // `similarTo`; the runtime accessor is what the builder decides on.
            (
              d.vector as unknown as Readonly<{
                similarTo: (query: readonly number[], limit: number) => never;
              }>
            ).similarTo([1, 0, 0], 5),
          ),
      ).toThrow(ConfigurationError);

      const refusal = expectConfigurationError(
        await rejectionOf(
          store.search.vector("TsPlainVectorDoc", {
            fieldPath: "vector",
            queryEmbedding: [1, 0, 0],
            limit: 10,
            expansion: "subclasses",
          }),
        ),
      );
      expect(refusal.details).toMatchObject({
        code: UNINDEXED_SEARCH_CODE,
        capability: "vector",
        kinds: ["TsTaggedVectorMemo"],
      });
    });

    it(`still runs a fulltext expansion whose subclass omits the searchable field, which holds no text there`, async (ctx) => {
      const store = await context.createStore(omittedSearchableGraph);
      if (store.backend.capabilities.fulltext?.supported !== true) {
        ctx.skip();
      }
      await store.nodes.TsSearchableDoc.create({
        title: "unique_ts_omitted_marker",
      });
      await store.nodes.TsTitlelessMemo.create({
        note: "unique_ts_omitted_marker",
      });

      const hits = await store.search.fulltext("TsSearchableDoc", {
        query: "unique_ts_omitted_marker",
        limit: 10,
        expansion: "subclasses",
      });
      expect(hits.map((hit) => hit.node.kind)).toEqual(["TsSearchableDoc"]);
    });

    it(`still runs a vector expansion whose subclass omits the embedding field, which holds no vector there`, async (ctx) => {
      const store = await context.createStore(omittedSearchableGraph);
      if (store.backend.capabilities.vector?.supported !== true) {
        ctx.skip();
      }
      await store.nodes.TsSearchableDoc.create({ vector: [1, 0, 0] });
      await store.nodes.TsTitlelessMemo.create({ note: "no vector" });

      const hits = await store.search.vector("TsSearchableDoc", {
        fieldPath: "vector",
        queryEmbedding: [1, 0, 0],
        limit: 10,
        expansion: "subclasses",
      });
      expect(hits.map((hit) => hit.node.kind)).toEqual(["TsSearchableDoc"]);
    });
  });

  describe("Typed subsumption — the removed includeSubClasses option", () => {
    it("is refused by every alias entry point, naming expansion", async () => {
      const store = await context.createStore(subsumptionGraph);
      const stated = { includeSubClasses: false } as never;
      const attempts: Readonly<Record<string, () => unknown>> = {
        from: () => store.query().from("TsMedia", "m", stated),
        fromDynamic: () => store.query().fromDynamic("TsMedia", "m", stated),
        to: () =>
          store
            .query()
            .from("TsMedia", "m")
            .traverse("tsLinksTo", "e")
            .to("TsMedia", "t", stated),
        toDynamic: () =>
          store
            .query()
            .from("TsMedia", "m")
            .traverse("tsLinksTo", "e")
            .toDynamic("TsMedia", "t", stated),
      };
      for (const attempt of Object.values(attempts)) {
        const refusal = expectConfigurationError(
          await rejectionOf(Promise.resolve().then(attempt)),
        );
        expect(refusal.details).toMatchObject({
          code: "QUERY_ALIAS_EXPANSION_INVALID",
          option: "includeSubClasses",
        });
        expect(refusal.message).toContain("expansion");
      }
    });

    it("leaves a null options argument from untyped code as no options", async () => {
      const store = await context.createStore(subsumptionGraph);
      await store.nodes.TsMedia.create({ title: "plain" });
      await store.nodes.TsPodcast.create({
        title: "cast",
        rssUrl: "https://x",
      });

      const rows = await store
        .query()
        // eslint-disable-next-line unicorn/no-null -- Validate invalid JavaScript input.
        .from("TsMedia", "m", null as never)
        .select((ctx) => ctx.m.kind)
        .execute();

      expect(rows.toSorted()).toEqual(["TsMedia", "TsPodcast"]);
    });

    it("is refused by every search leg instead of searching exact-kind", async (ctx) => {
      const store = await context.createStore(searchGraph);
      const { fulltext, vector } = store.backend.capabilities;
      const hasFulltext = fulltext?.supported === true;
      const hasVector = vector?.supported === true;
      if (!hasFulltext && !hasVector) ctx.skip();

      const queryEmbedding = SEARCH_QUERY_EMBEDDING;
      const attempts: Readonly<Record<string, () => Promise<unknown>>> = {
        ...(hasFulltext && {
          fulltext: () =>
            store.search.fulltext("TsSearchMedia", {
              query: "anything",
              limit: 10,
              includeSubClasses: true,
            } as never),
        }),
        ...(hasVector && {
          vector: () =>
            store.search.vector("TsSearchMedia", {
              fieldPath: "embedding",
              queryEmbedding,
              limit: 10,
              includeSubClasses: true,
            } as never),
        }),
        ...(hasFulltext &&
          hasVector && {
            hybrid: () =>
              store.search.hybrid("TsSearchMedia", {
                vector: { fieldPath: "embedding", queryEmbedding },
                fulltext: { query: "anything" },
                limit: 10,
                includeSubClasses: true,
              } as never),
          }),
      };
      for (const attempt of Object.values(attempts)) {
        const refusal = expectConfigurationError(await rejectionOf(attempt()));
        expect(refusal.details).toMatchObject({
          code: "QUERY_ALIAS_EXPANSION_INVALID",
          option: "includeSubClasses",
        });
      }
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
  describe("Typed subsumption — list sources", () => {
    it("expands each listed kind through its subclasses when no expansion is stated", async () => {
      const store = await seedListSourceStore(context);

      expect(
        kindsOf(
          await store
            .query()
            .from(LIST_KINDS, "n")
            .select((ctx) => ctx.n)
            .execute(),
        ),
      ).toEqual(["TsListCompany", "TsListMedia", "TsListPodcast"]);
      expect(
        kindsOf(
          await store
            .query()
            .from(LIST_KINDS, "n", { expansion: "subclasses" })
            .select((ctx) => ctx.n)
            .execute(),
        ),
      ).toEqual(["TsListCompany", "TsListMedia", "TsListPodcast"]);
      expect(
        kindsOf(
          await store
            .query()
            .from(LIST_KINDS, "n", { expansion: "exact" })
            .select((ctx) => ctx.n)
            .execute(),
        ),
      ).toEqual(["TsListCompany", "TsListMedia"]);
    });

    it("follows the store's queryDefaults.expansion like a single-kind source", async () => {
      const store = await seedListSourceStore(context, {
        queryDefaults: { expansion: "exact" },
      });

      const rows = await store
        .query()
        .from(LIST_KINDS, "n")
        .select((ctx) => ctx.n)
        .execute();
      expect(rows.map((row) => row.kind).toSorted()).toEqual([
        "TsListCompany",
        "TsListMedia",
      ]);
    });

    it("filters an expanded list on a parent-optional field a subclass omits", async () => {
      const store = await seedListSourceStore(context);

      const rows = await store
        .query()
        .from(LIST_KINDS, "n")
        .whereNode("n", (node) => node.rank.gte(1))
        .orderBy("n", "rank")
        .select((ctx) => ({ kind: ctx.n.kind, rank: ctx.n.rank }))
        .execute();
      expect(rows).toEqual([
        { kind: "TsListCompany", rank: 1 },
        { kind: "TsListMedia", rank: 2 },
      ]);
    });
  });

  describe("Typed subsumption — subclasses the compile-time graph does not declare", () => {
    it("refuses an unstated expansion after store.evolve() adds a subclass, and after a reload from the persisted schema", async () => {
      const backend = context.getBackend();
      const [store] = await createStoreWithSchema(
        runtimeSubclassGraph,
        backend,
      );
      const evolved = await store.evolve(runtimeSubclassExtension);
      await evolved.nodes.TsRuntimeDoc.create({ title: "runtime doc" });
      await requireDefined(evolved.getNodeCollection("TsRuntimeMemo")).create({
        title: "runtime memo",
      });

      await expectRefusedAndStatedAxesAnswered(evolved);

      const [reloaded] = await createStoreWithSchema(
        runtimeSubclassGraph,
        backend,
      );
      await expectRefusedAndStatedAxesAnswered(reloaded);
    });

    it("refuses a list source only for extension subclasses no listed kind's type admits", async () => {
      const backend = context.getBackend();
      const [store] = await createStoreWithSchema(listCoverageGraph, backend);
      const evolved = await store.evolve(listCoverageExtension);
      await evolved.nodes.TsCoverDoc.create({ title: "doc" });
      await evolved.nodes.TsCoverNote.create({ title: "note" });
      await evolved.nodes.TsCoverTopic.create({ title: "topic" });
      await evolved.nodes.TsCoverTag.create({ title: "tag" });

      // Every extra kind is listed, so the list type admits each row exactly.
      expect(
        kindsOf(
          await evolved
            .query()
            .from(["TsCoverDoc", "TsCoverNote", "TsCoverTag"], "n")
            .select((ctx) => ctx.n)
            .execute(),
        ),
      ).toEqual(["TsCoverDoc", "TsCoverNote", "TsCoverTag"]);
      // TsCoverTag is not listed, but TsCoverTopic is polymorphic at compile
      // time and expands to it, so the list type's TsCoverTopic member admits
      // TsCoverTag rows.
      expect(
        kindsOf(
          await evolved
            .query()
            .from(["TsCoverDoc", "TsCoverNote", "TsCoverTopic"], "n")
            .select((ctx) => ctx.n)
            .execute(),
        ),
      ).toEqual(["TsCoverDoc", "TsCoverNote", "TsCoverTag", "TsCoverTopic"]);

      const uncovered = expectConfigurationError(
        await rejectionOf(
          Promise.resolve().then(() =>
            evolved.query().from(["TsCoverDoc", "TsCoverNote"], "n"),
          ),
        ),
      );
      expect(uncovered.details).toMatchObject({
        code: UNTYPED_SUBCLASSES_CODE,
        kind: "TsCoverDoc",
        extraKinds: ["TsCoverTag"],
      });
      expect(uncovered.message).toContain("one of the listed kinds");
      expect(uncovered.suggestion).toContain("every listed kind");
      expect(uncovered.suggestion).not.toContain("fromDynamic()");
    });

    it("answers an unstated expansion when the compile-time graph already types the kind polymorphically", async () => {
      const backend = context.getBackend();
      const [store] = await createStoreWithSchema(subsumptionGraph, backend);
      const evolved = await store.evolve(
        defineGraphExtension({
          nodes: {
            TsEpisode: {
              properties: {
                title: { type: "string" },
                rssUrl: { type: "string" },
              },
            },
          },
          ontology: [
            { metaEdge: "subClassOf", from: "TsEpisode", to: "TsMedia" },
          ],
        }),
      );
      await evolved.nodes.TsMedia.create({ title: "plain" });
      await requireDefined(evolved.getNodeCollection("TsEpisode")).create({
        title: "episode",
        rssUrl: "https://x",
      });

      const rows = await evolved
        .query()
        .from("TsMedia", "m")
        .select((ctx) => ctx.m)
        .execute();
      expect(rows.map((row) => row.kind).toSorted()).toEqual([
        "TsEpisode",
        "TsMedia",
      ]);
    });
  });
}
