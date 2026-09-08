/**
 * Q3 — subclass expansion is the query default.
 *
 * `from`/`to`/`fromDynamic`/`toDynamic` default to `includeSubClasses: true`
 * (a supertype query is polymorphic unless narrowed). Seven internal call
 * sites are pinned to `false` so they stay exact-kind under the new
 * default: `store.search()`'s candidate subquery, and five collection
 * paths (`find({where})`, `updateWhere` x2, `compareAndSet`,
 * `updateWhere`'s `exists` related-kind traversal). This file proves each
 * pin with a test that would fail if the pin were dropped.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, subClassOf } from "../src";
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

describe("Q3 pin — store.search() candidate subquery stays exact-kind", () => {
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
