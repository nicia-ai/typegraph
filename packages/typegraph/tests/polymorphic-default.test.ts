/**
 * Q3 — subclass expansion is the query default.
 *
 * `from`/`to`/`fromDynamic`/`toDynamic` default to `includeSubClasses: true`
 * (a supertype query is polymorphic unless narrowed). Seven internal call
 * sites are pinned to `false` so they stay exact-kind under the new
 * default: `store.search()`'s candidate subquery, and five collection
 * paths (`find({where})`, `updateWhere` x2 (its own root, plus the `exists`
 * leg's root), `compareAndSet`, and `updateWhere`'s `exists` RELATED-kind
 * traversal).
 *
 * Two shapes of pin, told apart honestly (C13-R1-01) rather than claimed
 * uniformly load-bearing:
 *
 * - `find({ where })` and the `exists` leg's RELATED-kind `toDynamic` pin
 *   ARE genuinely load-bearing: dropping either changes a real result set,
 *   and the tests below fail without them (mutation-checked).
 * - The other five pins — `search()`'s candidate subquery, `compareAndSet`'s
 *   root, `updateWhere`'s own root, and the `exists` leg's OWN root
 *   `fromDynamic` — are DEFENSE IN DEPTH with no observable effect today.
 *   Each candidate id they widen still passes through an outer exact-kind
 *   fence one layer down (`WHERE nodes.kind = <collection's kind>` in
 *   `buildUpdateNodeSet`, or `nodeKind: kind` on the `backend.fulltextSearch`
 *   call), so a subclass id the pin would have let through is filtered out
 *   there regardless. Kept as an explicit second layer against a future
 *   change to that outer fence, not because today's tests can observe them
 *   failing — dropping any of the five leaves every test in this file
 *   green.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, subClassOf } from "../src";
import { searchable } from "../src/core/searchable";
import { createStoreWithSchema } from "../src/store/store";
import { requireDefined } from "../src/utils/presence";
import { createInitializedStore, createTestBackend } from "./test-utils";

const Media = defineNode("Media", {
  schema: z.object({ title: z.string() }),
});
const Podcast = defineNode("Podcast", {
  schema: z.object({ title: z.string(), rssUrl: z.string() }),
});

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: { Media: { type: Media }, Podcast: { type: Podcast } },
    edges: {},
    ontology: [subClassOf(Podcast, Media)],
  });
}

describe("Q3 — from()/to() default to includeSubClasses: true", () => {
  it("store.query().from('Media', 'm') returns Podcast rows by default", async () => {
    const backend = createTestBackend();
    const store = await createInitializedStore(
      buildGraph("q3_default_on"),
      backend,
    );
    await store.nodes.Media.create({ title: "plain media" });
    await store.nodes.Podcast.create({
      title: "a podcast",
      rssUrl: "https://x",
    });

    const rows = await store
      .query()
      .from("Media", "m")
      .select((ctx) => ctx.m)
      .execute();

    expect(rows.map((row) => row.kind).toSorted()).toEqual([
      "Media",
      "Podcast",
    ]);
  });

  it("{ includeSubClasses: false } restores exact-kind behavior on from()", async () => {
    const backend = createTestBackend();
    const store = await createInitializedStore(
      buildGraph("q3_default_off_per_call"),
      backend,
    );
    await store.nodes.Media.create({ title: "plain media" });
    await store.nodes.Podcast.create({
      title: "a podcast",
      rssUrl: "https://x",
    });

    const rows = await store
      .query()
      .from("Media", "m", { includeSubClasses: false })
      .select((ctx) => ctx.m)
      .execute();

    expect(rows.map((row) => row.kind)).toEqual(["Media"]);
  });

  it("createStore(..., { queryDefaults: { includeSubClasses: false } }) restores exact-kind everywhere", async () => {
    const backend = createTestBackend();
    const graph = buildGraph("q3_store_default_off");
    const [store] = await createStoreWithSchema(graph, backend, {
      queryDefaults: { includeSubClasses: false },
    });
    await store.nodes.Media.create({ title: "plain media" });
    await store.nodes.Podcast.create({
      title: "a podcast",
      rssUrl: "https://x",
    });

    const rows = await store
      .query()
      .from("Media", "m")
      .select((ctx) => ctx.m)
      .execute();

    expect(rows.map((row) => row.kind)).toEqual(["Media"]);
  });
});

describe("Q3 pin — store.search() candidate subquery stays exact-kind (defense in depth)", () => {
  // NOT mutation-checked: `backend.fulltextSearch({ nodeKind: kind, ... })`
  // already scopes the physical search to the exact kind regardless of what
  // the candidate subquery's `from()` widens to, so dropping the
  // `{ includeSubClasses: false }` pin at src/store/search.ts leaves this
  // test green. See the module docblock above.
  it("a fulltext search with no includeSubClasses does not return subclass rows", async () => {
    const SearchableMedia = defineNode("SearchMedia", {
      schema: z.object({ title: searchable({ language: "english" }) }),
    });
    const SearchablePodcast = defineNode("SearchPodcast", {
      schema: z.object({
        title: searchable({ language: "english" }),
        rssUrl: z.string(),
      }),
    });
    const graph = defineGraph({
      id: "q3_search_pin",
      nodes: {
        SearchMedia: { type: SearchableMedia },
        SearchPodcast: { type: SearchablePodcast },
      },
      edges: {},
      ontology: [subClassOf(SearchablePodcast, SearchableMedia)],
    });
    const backend = createTestBackend();
    const store = await createInitializedStore(graph, backend);
    await store.nodes.SearchMedia.create({ title: "unique_pin_marker media" });
    await store.nodes.SearchPodcast.create({
      title: "unique_pin_marker podcast",
      rssUrl: "https://x",
    });

    // A `where` predicate is required to exercise `buildKindCandidates` —
    // the pinned line under test compiles ONLY when a `where` predicate is
    // present (the unfiltered path never builds a query-builder candidate
    // subquery at all).
    const results = await store.search.fulltext("SearchMedia", {
      query: "unique_pin_marker",
      limit: 10,
      where: (accessor) => accessor.title.contains("unique_pin_marker"),
    });

    expect(results.map((result) => result.node.kind)).toEqual(["SearchMedia"]);
  });

  it("includeSubClasses: true on search() itself does return subclass rows once each", async () => {
    const SearchableMedia2 = defineNode("SearchMedia2", {
      schema: z.object({ title: searchable({ language: "english" }) }),
    });
    const SearchablePodcast2 = defineNode("SearchPodcast2", {
      schema: z.object({
        title: searchable({ language: "english" }),
        rssUrl: z.string(),
      }),
    });
    const graph = defineGraph({
      id: "q3_search_expand",
      nodes: {
        SearchMedia2: { type: SearchableMedia2 },
        SearchPodcast2: { type: SearchablePodcast2 },
      },
      edges: {},
      ontology: [subClassOf(SearchablePodcast2, SearchableMedia2)],
    });
    const backend = createTestBackend();
    const store = await createInitializedStore(graph, backend);
    await store.nodes.SearchMedia2.create({
      title: "unique_pin_marker2 media",
    });
    await store.nodes.SearchPodcast2.create({
      title: "unique_pin_marker2 podcast",
      rssUrl: "https://x",
    });

    const results = await store.search.fulltext("SearchMedia2", {
      query: "unique_pin_marker2",
      limit: 10,
      includeSubClasses: true,
    });

    expect(results.map((result) => result.node.kind).toSorted()).toEqual([
      "SearchMedia2",
      "SearchPodcast2",
    ]);
  });
});

describe("Q3 pin — collection APIs stay exact-kind", () => {
  // Load-bearing: `nodes.Media.find()`'s no-`where` branch goes straight to
  // the exact-kind backend find path, and this pin is what keeps
  // `find({ where })` returning the identical row set. Mutation-checked:
  // dropping `{ includeSubClasses: false }` at node-collection.ts's `find`
  // makes `findWhere` also return the `Podcast` row, failing this test.
  it("nodes.Media.find({ where }) and find() return the same row set", async () => {
    const backend = createTestBackend();
    const store = await createInitializedStore(
      buildGraph("q3_find_pin"),
      backend,
    );
    await store.nodes.Media.create({ title: "alpha" });
    await store.nodes.Podcast.create({ title: "alpha", rssUrl: "https://x" });

    const findAll = await store.nodes.Media.find();
    const findWhere = await store.nodes.Media.find({
      where: (accessor) => accessor.title.eq("alpha"),
    });

    expect(findAll.map((row) => row.id).toSorted()).toEqual(
      findWhere.map((row) => row.id).toSorted(),
    );
    expect(findAll).toHaveLength(1);
  });

  // NOT mutation-checked: `executeNodeSetUpdate`'s outer
  // `WHERE nodes.kind = params.kind` re-filters the candidate ids to
  // `Media` regardless of what the `updateWhere` root's `fromDynamic` pin
  // widens to, so dropping it at node-collection.ts leaves this test green.
  // Defense in depth (see the module docblock above).
  it("nodes.Media.updateWhere({ all: true }) touches zero Podcast rows", async () => {
    const backend = createTestBackend();
    const store = await createInitializedStore(
      buildGraph("q3_update_where_pin"),
      backend,
    );
    await store.nodes.Media.create({ title: "before" });
    const podcast = await store.nodes.Podcast.create({
      title: "before",
      rssUrl: "https://x",
    });

    const result = await store.nodes.Media.updateWhere({
      all: true,
      patch: { title: "after" },
    });

    expect(result.affectedCount).toBe(1);
    const stillPodcast = await store.nodes.Podcast.getById(podcast.id);
    expect(requireDefined(stillPodcast).title).toBe("before");
  });

  // NOT mutation-checked: same outer-fence reason as updateWhere above —
  // `compareAndSet`'s root `fromDynamic` pin widens the CANDIDATE set, but
  // the final UPDATE still filters `nodes.kind = "Media"`, which a Podcast
  // row never matches. Defense in depth (see the module docblock above).
  it("nodes.Media.compareAndSet(podcastId, ...) returns false — exact-kind", async () => {
    const backend = createTestBackend();
    const store = await createInitializedStore(
      buildGraph("q3_compare_and_set_pin"),
      backend,
    );
    const podcast = await store.nodes.Podcast.create({
      title: "before",
      rssUrl: "https://x",
    });

    const applied = await store.nodes.Media.compareAndSet(podcast.id as never, {
      expected: { title: "before" },
      patch: { title: "after" },
    });

    expect(applied).toBe(false);
  });
});

describe("Q3 pin — updateWhere()'s exists-leg RELATED-kind toDynamic (load-bearing)", () => {
  // Unlike the root-kind pins above, this one is NOT behind the outer
  // `WHERE nodes.kind = params.kind` fence: the related node's kind gates
  // whether the `exists` predicate is satisfied at all, and only the
  // ROOT node's id is projected as a candidate. Dropping
  // `{ includeSubClasses: false }` on the `exists` leg's `toDynamic(relation.relatedKind, ...)`
  // (node-collection.ts) genuinely changes the result: an `exists` check
  // against `Tag` would then also be satisfied by a `SpecialTag`-only
  // related row. Mutation-checked.
  it("an exists check against a parent kind is not satisfied by a subclass-only related row", async () => {
    const Item = defineNode("PDItem", {
      schema: z.object({ title: z.string() }),
    });
    const Tag = defineNode("PDTag", { schema: z.object({ name: z.string() }) });
    const SpecialTag = defineNode("PDSpecialTag", {
      schema: z.object({ name: z.string(), extra: z.string() }),
    });
    const tagged = defineEdge("pdTagged", { schema: z.object({}) });
    const graph = defineGraph({
      id: "q3_exists_related_kind_pin",
      nodes: {
        PDItem: { type: Item },
        PDTag: { type: Tag },
        PDSpecialTag: { type: SpecialTag },
      },
      edges: {
        pdTagged: { type: tagged, from: [Item], to: [Tag, SpecialTag] },
      },
      ontology: [subClassOf(SpecialTag, Tag)],
    });
    const backend = createTestBackend();
    const store = await createInitializedStore(graph, backend);
    const item = await store.nodes.PDItem.create({ title: "before" });
    const specialTag = await store.nodes.PDSpecialTag.create({
      name: "s",
      extra: "x",
    });
    await store.edges.pdTagged.create(item, specialTag, {});

    const result = await store.nodes.PDItem.updateWhere({
      exists: [
        { edgeKind: "pdTagged", direction: "out", relatedKind: "PDTag" },
      ],
      patch: { title: "after" },
    });

    expect(result.affectedCount).toBe(0);
    const stillItem = await store.nodes.PDItem.getById(item.id);
    expect(requireDefined(stillItem).title).toBe("before");
  });
});

describe("Q3 — store.subgraph() is unaffected by the query default", () => {
  it("includeKinds is resolved literally regardless of subClassOf", async () => {
    const backend = createTestBackend();
    const store = await createInitializedStore(
      buildGraph("q3_subgraph_pin"),
      backend,
    );
    const media = await store.nodes.Media.create({ title: "root" });
    await store.nodes.Podcast.create({ title: "other", rssUrl: "https://x" });

    const result = await store.subgraph(media.id, { edges: [] });

    expect(result.root).toBeDefined();
    expect(result.nodes.size).toBe(1);
    expect(requireDefined(result.root).kind).toBe("Media");
  });
});
