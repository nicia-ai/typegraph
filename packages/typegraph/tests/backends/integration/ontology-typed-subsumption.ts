/**
 * Cross-backend query semantics for C.1/C.2/Q3/C.3 (typed subsumption).
 *
 * Query-feature tests live in the shared cross-backend suite (AGENTS.md
 * "Backend parity" §2) — a per-dialect test would happily certify a
 * divergence between SQLite and PostgreSQL; only the same case run on both
 * engines verifies equivalence.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  broader,
  defineEdge,
  defineGraph,
  defineNode,
  searchable,
  subClassOf,
} from "../../../src";
import { ConfigurationError } from "../../../src/errors";
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
// admits every concept kind (the includeNarrower SUCCESS case),
// `tsConceptLinkNarrow` admits only the root (the endpoint-refused case) —
// `includeNarrower` is not an assignability axis, so admission must be
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
  },
  ontology: [
    broader(MidConcept, RootConcept),
    broader(LeafConcept, MidConcept),
  ],
});

// Fulltext fixture: a distinct graph so its `searchable()` field doesn't
// have to be threaded through `subsumptionGraph`'s other, non-search cases.
const SearchMedia = defineNode("TsSearchMedia", {
  schema: z.object({ title: searchable({ language: "english" }) }),
});
const SearchPodcast = defineNode("TsSearchPodcast", {
  schema: z.object({
    title: searchable({ language: "english" }),
    rssUrl: z.string(),
  }),
});

const searchGraph = defineGraph({
  id: "typed_subsumption_search_integration",
  nodes: {
    TsSearchMedia: { type: SearchMedia },
    TsSearchPodcast: { type: SearchPodcast },
  },
  edges: {},
  ontology: [subClassOf(SearchPodcast, SearchMedia)],
});

export function registerOntologyTypedSubsumptionIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Typed subsumption — polymorphic default (Q3)", () => {
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
        .from("TsMedia", "m", { includeSubClasses: false })
        .select((ctx) => ctx.m)
        .execute();
      expect(exact.map((row) => row.kind)).toEqual(["TsMedia"]);
    });

    // Mutation-checked: flipping the store's default
    // `queryDefaults.includeSubClasses` from `true` to `false` drops the
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
    // `{ includeSubClasses: false }` pin leaves that assertion green on
    // BOTH engines — same defense-in-depth shape the SQLite-only pin in
    // tests/polymorphic-default.test.ts documents. This is cross-backend
    // PARITY coverage (AGENTS.md "Backend parity" §2: the candidate
    // subquery composes with FTS5 on SQLite and tsvector on PostgreSQL, so
    // only running the case on both engines can prove they agree), not an
    // independent load-bearing guard.
    it("fulltext search's candidate subquery stays exact-kind by default and expands with includeSubClasses, on both engines", async (ctx) => {
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
        includeSubClasses: true,
      });
      expect(expanded.map((result) => result.node.kind).toSorted()).toEqual([
        "TsSearchMedia",
        "TsSearchPodcast",
      ]);
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

  describe("C.3 — includeNarrower over a kind taxonomy", () => {
    it("from() expands through a three-level broader/narrower chain", async () => {
      const store = await context.createStore(narrowerGraph);
      await store.nodes.TsRootConcept.create({ name: "root" });
      await store.nodes.TsMidConcept.create({ name: "mid" });
      await store.nodes.TsLeafConcept.create({ name: "leaf" });

      const rows = await store
        .query()
        .from("TsRootConcept", "c", { includeNarrower: true })
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
        .to("TsRootConcept", "target", { includeNarrower: true })
        .select((ctx) => ctx.target)
        .execute();

      expect(rows.map((row) => row.kind).toSorted()).toEqual([
        "TsLeafConcept",
        "TsMidConcept",
        "TsRootConcept",
      ]);
    });

    it("refuses includeNarrower + includeSubClasses on one alias identically on both engines", async () => {
      const store = await context.createStore(narrowerGraph);
      expect(() =>
        store.query().from("TsRootConcept", "c", {
          includeSubClasses: true,
          includeNarrower: true,
        } as never),
      ).toThrow(ConfigurationError);
    });

    it("refuses an includeNarrower expansion naming an unregistered kind, identically on both engines", async () => {
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
        store.query().from("TsRootConcept", "c", { includeNarrower: true });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigurationError);
      expect((caught as ConfigurationError).details["code"]).toBe(
        "ONTOLOGY_NARROWER_KIND_NOT_REGISTERED",
      );
    });

    it("refuses an includeNarrower expansion whose kinds are not admitted edge endpoints, identically on both engines", async () => {
      // tsConceptLinkNarrow admits ONLY TsRootConcept as a `to` endpoint —
      // includeNarrower's expansion (Mid, Leaf) is not an assignability
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
          .to("TsRootConcept", "target", { includeNarrower: true });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigurationError);
      expect((caught as ConfigurationError).details["code"]).toBe(
        "ONTOLOGY_NARROWER_ENDPOINT_NOT_ADMITTED",
      );
    });
  });
}
