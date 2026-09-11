/**
 * The composition delete cascade (item E-c, plan §4.2-4.4).
 *
 * Two layers of coverage:
 *
 *  - UNIT tests directly against `composition-cascade.ts`'s two exports —
 *    `compositionEdgeCounts` (the population predicate) and
 *    `planCompositionCascade` (the leaf-first closure walk, and its
 *    should-be-impossible invariant throws) — driven with hand-built rows so
 *    the population contrast and the invariant branches are exercised
 *    directly, without depending on a real cascade reaching them.
 *  - INTEGRATION tests through the real Store API: `store.nodes.Podcast.delete`
 *    etc. against a Podcast -> Episode -> Segment composition graph (the exact
 *    fixture `ontology-composition-declaration.test.ts` uses for the registry
 *    layer), proving the cascade end to end. A second fixture (Album
 *    -[hasTrack]-> Track -[noteOf]<- Note) covers the `hasPart` /
 *    `partSide: "to"` orientation and a closure that mixes both
 *    orientations in one walk.
 *
 * MUTATION CHECKS are recorded inline, next to the assertion each one
 * guards, as an `// MUTATION:` comment naming the exact change and which
 * assertion it flips.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  hasPart,
  partOf,
} from "../src";
import {
  deriveBackend,
  type ExactBackendOverlay,
} from "../src/backend/derive-backend";
import { generateSqliteDDL } from "../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import {
  type EdgeRow,
  type GraphBackend,
  type TransactionBackend,
} from "../src/backend/types";
import { buildKindRegistry } from "../src/registry";
import {
  compositionEdgeCounts,
  planCompositionCascade,
} from "../src/store/operations/composition-cascade";
import { uncapturedGraphWriteLock } from "../src/store/recorded-capture/clock";
import { transactionDeleteNodeWithPolicy } from "../src/store/runtime-port";
import { type OperationHookContext } from "../src/store/types";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend, matchingObject } from "./test-utils";

const emptySchema = z.object({});

// ============================================================
// Fixture: Podcast -> Episode -> Segment (the E-a registry fixture)
// ============================================================

const Podcast = defineNode("Podcast", {
  schema: z.object({ title: z.string().default("untitled") }),
});
const Episode = defineNode("Episode", {
  schema: z.object({ title: z.string().default("untitled") }),
});
const Segment = defineNode("Segment", { schema: emptySchema });
const Tag = defineNode("Tag", { schema: emptySchema });

const episodeOf = defineEdge("episodeOf", { schema: emptySchema });
const segmentOf = defineEdge("segmentOf", { schema: emptySchema });
const taggedWith = defineEdge("taggedWith", { schema: emptySchema });

function buildPodcastGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      Podcast: {
        type: Podcast,
        unique: [
          {
            name: "podcast_title",
            fields: ["title"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      Episode: {
        type: Episode,
        // `disconnect`, not the default `restrict`: an Episode that a part
        // once reparented AWAY from (§ oneActive) still carries that ENDED
        // segmentOf row (`findEdgesConnectedTo` returns ended-but-undeleted
        // edges, valid_to notwithstanding) — a plain `restrict` Episode would
        // therefore refuse to delete even once no LIVE part remains, which is
        // orthogonal to what this fixture's tests are about.
        onDelete: "disconnect",
        unique: [
          {
            name: "episode_title",
            fields: ["title"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      Segment: { type: Segment, onDelete: "restrict" },
      Tag: { type: Tag },
    },
    edges: {
      episodeOf: {
        type: episodeOf,
        from: [Episode],
        to: [Podcast],
        cardinality: "one",
      },
      segmentOf: {
        type: segmentOf,
        from: [Segment],
        to: [Episode],
        cardinality: "oneActive",
      },
      taggedWith: { type: taggedWith, from: [Segment], to: [Tag] },
    },
    ontology: [
      partOf(Episode, Podcast, { via: episodeOf }),
      partOf(Segment, Episode, { via: segmentOf }),
    ],
  });
}

// ============================================================
// Unit tests: compositionEdgeCounts
// ============================================================

describe("compositionEdgeCounts", () => {
  const liveRow: Pick<EdgeRow, "valid_to"> = { valid_to: undefined };
  const endedRow: Pick<EdgeRow, "valid_to"> = {
    valid_to: "2020-01-01T00:00:00.000Z",
  };

  it("population 'one' counts an ended row exactly as a live one", () => {
    // MUTATION: change this predicate's `pair.population === "one"` branch to
    // `false` (always defer to `valid_to`) and this assertion flips.
    expect(
      compositionEdgeCounts({ partSide: "from", population: "one" }, endedRow),
    ).toBe(true);
    expect(
      compositionEdgeCounts({ partSide: "from", population: "one" }, liveRow),
    ).toBe(true);
  });

  it("population 'oneActive' counts only an open-ended row", () => {
    // MUTATION: drop the `row.valid_to === undefined` disjunct and this
    // assertion flips (an ended row would wrongly still count).
    expect(
      compositionEdgeCounts(
        { partSide: "from", population: "oneActive" },
        endedRow,
      ),
    ).toBe(false);
    expect(
      compositionEdgeCounts(
        { partSide: "from", population: "oneActive" },
        liveRow,
      ),
    ).toBe(true);
  });

  it("is indifferent to partSide — only population decides", () => {
    expect(
      compositionEdgeCounts(
        { partSide: "to", population: "oneActive" },
        endedRow,
      ),
    ).toBe(false);
    expect(
      compositionEdgeCounts({ partSide: "to", population: "one" }, endedRow),
    ).toBe(true);
  });
});

// ============================================================
// Unit tests: planCompositionCascade — ordering and invariants
// ============================================================

describe("planCompositionCascade", () => {
  it("returns the empty plan for a kind that declares no composition parts", async () => {
    const registry = buildKindRegistry(buildPodcastGraph("cascade-plan-empty"));
    const backend = createTestBackend();
    const plan = await planCompositionCascade(
      { graphId: "g", registry, lock: uncapturedGraphWriteLock() },
      "Tag",
      "t1",
      backend,
    );
    expect(plan).toEqual({ members: [], consumedEdgeIds: new Set() });
  });

  it("orders members LEAF-FIRST: Segment before its Episode, before its Podcast", async () => {
    const graph = buildPodcastGraph("cascade-plan-order");
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);
    const podcast = await store.nodes.Podcast.create({ title: "p" });
    const episode = await store.nodes.Episode.create({ title: "e" });
    const segment = await store.nodes.Segment.create({});
    await store.edges.episodeOf.create(episode, podcast, {});
    await store.edges.segmentOf.create(segment, episode, {});

    const registry = buildKindRegistry(graph);
    const plan = await planCompositionCascade(
      { graphId: graph.id, registry, lock: uncapturedGraphWriteLock() },
      "Podcast",
      podcast.id,
      backend,
    );
    // MUTATION: drop the `.toReversed()` in `cascadeDeletionOrder` and this
    // assertion flips to [Episode, Segment] (BFS discovery order).
    expect(plan.members.map((member) => member.kind)).toEqual([
      "Segment",
      "Episode",
    ]);
    expect(plan.consumedEdgeIds.size).toBe(2);
  });

  it("orders two SIBLING parts of one whole by code-point (kind, id), not by the order they were created or read", async () => {
    const graph = buildPodcastGraph("cascade-plan-sibling-order");
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);
    const podcast = await store.nodes.Podcast.create({ title: "p" });
    const episode = await store.nodes.Episode.create(
      { title: "e" },
      { id: "cascade-order-episode" },
    );
    // Created in DESCENDING id order, so creation order and sort order
    // disagree: anything that reports the closure in discovery (or row-read)
    // order instead of sorting it answers "b" before "a".
    await store.nodes.Segment.create({}, { id: "cascade-order-b" });
    await store.nodes.Segment.create({}, { id: "cascade-order-a" });
    await store.edges.episodeOf.create(episode, podcast, {});
    await store.edges.segmentOf.create(
      { kind: "Segment", id: "cascade-order-b" },
      episode,
      {},
    );
    await store.edges.segmentOf.create(
      { kind: "Segment", id: "cascade-order-a" },
      episode,
      {},
    );

    const registry = buildKindRegistry(graph);
    const plan = await planCompositionCascade(
      { graphId: graph.id, registry, lock: uncapturedGraphWriteLock() },
      "Podcast",
      podcast.id,
      backend,
    );
    // MUTATION: reverse the per-round sort in `cascadeDeletionOrder`
    // (src/store/operations/composition-cascade.ts) — swap the comparison's
    // operands — and the two segments come back "b" before "a", failing this
    // assertion on every run.
    expect(plan.members.map((member) => `${member.kind}/${member.id}`)).toEqual(
      [
        "Segment/cascade-order-a",
        "Segment/cascade-order-b",
        "Episode/cascade-order-episode",
      ],
    );
  });

  it("reports that same sibling order on the delete's receipt", async () => {
    const graph = buildPodcastGraph("cascade-receipt-sibling-order");
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);
    const podcast = await store.nodes.Podcast.create({ title: "p" });
    const episode = await store.nodes.Episode.create(
      { title: "e" },
      { id: "receipt-order-episode" },
    );
    await store.nodes.Segment.create({}, { id: "receipt-order-b" });
    await store.nodes.Segment.create({}, { id: "receipt-order-a" });
    await store.edges.episodeOf.create(episode, podcast, {});
    await store.edges.segmentOf.create(
      { kind: "Segment", id: "receipt-order-b" },
      episode,
      {},
    );
    await store.edges.segmentOf.create(
      { kind: "Segment", id: "receipt-order-a" },
      episode,
      {},
    );

    const { receipt } = await store.transactionWithReceipt(async (tx) => {
      await tx.nodes.Podcast.delete(podcast.id);
    });

    // The plan's order IS the reported order: the receipt is a projection of
    // it, never a second walk. (Same MUTATION as the test above.)
    expect(receipt.cascadedParts).toEqual([
      { kind: "Segment", id: "receipt-order-a" },
      { kind: "Segment", id: "receipt-order-b" },
      { kind: "Episode", id: "receipt-order-episode" },
    ]);
  });

  it("throws CompositionCycleError on a revisit rather than truncating", async () => {
    const graph = buildPodcastGraph("cascade-plan-revisit");
    const registry = buildKindRegistry(graph);
    // A fake backend whose rows admit the SAME (kind, id) member twice — an
    // INSTANCE-level cycle, which reflexive composition permits at the kind
    // level (nothing yet refuses the corresponding write-time cycle) — hand-
    // built here to reach the throw directly rather than depending on a real
    // reflexive fixture.
    const rootToEpisode: EdgeRow = {
      graph_id: "g",
      id: "root-to-episode",
      kind: "episodeOf",
      from_kind: "Episode",
      from_id: "e1",
      to_kind: "Podcast",
      to_id: "p1",
      props: {},
      valid_from: undefined,
      valid_to: undefined,
      created_at: "now",
      updated_at: "now",
      deleted_at: undefined,
    };
    // Two DISTINCT segmentOf rows both binding the same Segment "s1" to
    // Episode "e1": the second one, processed in the same round, resolves
    // to an already-visited member.
    const episodeToSegment: EdgeRow = {
      ...rootToEpisode,
      id: "episode-to-segment-1",
      kind: "segmentOf",
      from_kind: "Segment",
      from_id: "s1",
      to_kind: "Episode",
      to_id: "e1",
    };
    const episodeToSegmentAgain: EdgeRow = {
      ...episodeToSegment,
      id: "episode-to-segment-2",
    };
    const fakeBackend = {
      findEdgesByHeterogeneousEndpointSet: undefined,
      findEdgesConnectedTo: ({ nodeId }: { nodeId: string }) =>
        Promise.resolve(
          nodeId === "p1" ? [rootToEpisode]
          : nodeId === "e1" ? [episodeToSegment, episodeToSegmentAgain]
          : [],
        ),
    } as unknown as GraphBackend;

    await expect(
      planCompositionCascade(
        { graphId: "g", registry, lock: uncapturedGraphWriteLock() },
        "Podcast",
        "p1",
        fakeBackend,
      ),
    ).rejects.toThrow(
      matchingObject({
        name: "CompositionCycleError",
        code: "COMPOSITION_CYCLE_DETECTED",
      }),
    );
  });
});

// ============================================================
// Unit test: the heterogeneous set read's OWN temporal disposition
//
// `readWholeSideEdges` falls back to `findEdgesConnectedTo` whenever the set
// read returns zero rows — a childless round on a set-read-capable backend
// is therefore never PROOF the set read itself handles an ended row
// correctly; it could be silently rerouting to the (separately correct)
// fallback every time. This asserts the set read ALONE, bypassing that
// fallback entirely, so a future regression narrowing it to only
// open-ended rows cannot hide behind the reroute.
// ============================================================

describe("findEdgesByHeterogeneousEndpointSet — the set read's own temporal disposition", () => {
  it("returns an ended-but-undeleted composition edge with excludeDeleted alone (no temporalMode)", async () => {
    const graph = buildPodcastGraph("cascade-set-read-ended-row");
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const podcast = await store.nodes.Podcast.create({ title: "p" });
    const episode = await store.nodes.Episode.create({ title: "e" });
    const edge = await store.edges.episodeOf.create(episode, podcast, {});
    await store.edges.episodeOf.update(
      edge.id,
      {},
      { validTo: new Date().toISOString() },
    );

    const setRead = backend.findEdgesByHeterogeneousEndpointSet;
    if (setRead === undefined) {
      throw new Error(
        "createTestBackend() is expected to license findEdgesByHeterogeneousEndpointSet",
      );
    }
    // MUTATION: add `temporalMode: "current"` (or any validTo-filtering
    // condition) to `buildTemporalConditions`'s unconditional branch and
    // this row disappears — `compositionEdgeCounts`, not the read, is
    // supposed to be the only place `population: "one"` vs `"oneActive"`
    // is decided.
    const rows = await setRead({
      graphId: graph.id,
      side: "to",
      endpoints: [{ kind: "Podcast", id: podcast.id }],
      edgeKinds: ["episodeOf"],
      excludeDeleted: true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(edge.id);
    expect(rows[0]?.valid_to).toBeDefined();
  });
});

// ============================================================
// Integration tests through the real Store API
// ============================================================

describe("composition cascade — delete", () => {
  it("deletes Podcast -> Episode -> Segment leaf-first in one transaction, releasing uniqueness and leaving no composition edge behind", async () => {
    const graph = buildPodcastGraph("cascade-two-level");
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const podcast = await store.nodes.Podcast.create({ title: "My Show" });
    const episode = await store.nodes.Episode.create({ title: "Pilot" });
    const segment = await store.nodes.Segment.create({});
    const episodeOfEdge = await store.edges.episodeOf.create(
      episode,
      podcast,
      {},
    );
    const segmentOfEdge = await store.edges.segmentOf.create(
      segment,
      episode,
      {},
    );

    await store.nodes.Podcast.delete(podcast.id);

    await expect(
      store.nodes.Podcast.getById(podcast.id),
    ).resolves.toBeUndefined();
    await expect(
      store.nodes.Episode.getById(episode.id),
    ).resolves.toBeUndefined();
    await expect(
      store.nodes.Segment.getById(segment.id),
    ).resolves.toBeUndefined();
    await expect(
      store.edges.episodeOf.getById(episodeOfEdge.id),
    ).resolves.toBeUndefined();
    await expect(
      store.edges.segmentOf.getById(segmentOfEdge.id),
    ).resolves.toBeUndefined();

    // Uniqueness released: a fresh Episode may reuse the deleted title.
    const reusedTitle = await store.nodes.Episode.create({ title: "Pilot" });
    expect(reusedTitle.title).toBe("Pilot");
  });

  it("reads each cascade member's row ONCE: the soft delete writes against the row the plan proved live", async () => {
    const graph = buildPodcastGraph("cascade-member-row-reuse");
    const raw = createTestBackend();
    const reads: string[] = [];
    function countReads<T extends GraphBackend | TransactionBackend>(
      target: T,
    ): T {
      return deriveBackend<T, Partial<T>>(target, {
        getNode: async (graphId: string, kind: string, id: string) => {
          reads.push(`${kind}/${id}`);
          return target.getNode(graphId, kind, id);
        },
      } as ExactBackendOverlay<T, Partial<T>>);
    }
    const backend = deriveBackend(countReads(raw), {
      transaction: (fn, options) =>
        raw.transaction((target) => fn(countReads(target)), options),
    });
    const [store] = await createStoreWithSchema(graph, backend);

    const podcast = await store.nodes.Podcast.create({ title: "My Show" });
    const episode = await store.nodes.Episode.create({ title: "Pilot" });
    const segment = await store.nodes.Segment.create({});
    await store.edges.episodeOf.create(episode, podcast, {});
    await store.edges.segmentOf.create(segment, episode, {});

    reads.length = 0;
    await store.nodes.Podcast.delete(podcast.id);

    // One read per member, taken by `planCompositionCascade`'s liveness pass;
    // the delete of each member writes against THAT row.
    expect(
      reads.filter((read) => read === `Episode/${episode.id}`),
    ).toHaveLength(1);
    expect(
      reads.filter((read) => read === `Segment/${segment.id}`),
    ).toHaveLength(1);
  });
  // MUTATION: stop passing `member.row` as `deleteNodeRowInFrame`'s `existing`
  // in `runCompositionCascade` (src/store/operations/node-operations.ts) —
  // each member is then read a second time for its own pre-image and both
  // filters find 2 reads.

  it("aborts a restricting grandchild's delete ATOMICALLY — zero rows changed", async () => {
    const graph = buildPodcastGraph("cascade-restrict-abort");
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const podcast = await store.nodes.Podcast.create({ title: "My Show" });
    const episode = await store.nodes.Episode.create({ title: "Pilot" });
    const segment = await store.nodes.Segment.create({});
    const tag = await store.nodes.Tag.create({});
    await store.edges.episodeOf.create(episode, podcast, {});
    await store.edges.segmentOf.create(segment, episode, {});
    // Segment's ONE non-composition edge — the reason it restricts.
    await store.edges.taggedWith.create(segment, tag, {});

    const countsBefore = await Promise.all([
      store.nodes.Podcast.getById(podcast.id),
      store.nodes.Episode.getById(episode.id),
      store.nodes.Segment.getById(segment.id),
      store.nodes.Tag.getById(tag.id),
    ]);

    await expect(store.nodes.Podcast.delete(podcast.id)).rejects.toThrow(
      matchingObject({
        name: "RestrictedDeleteError",
        details: matchingObject({ nodeKind: "Segment", nodeId: segment.id }),
      }),
    );

    // Nothing changed: not the Podcast, not the Episode, not the Segment.
    const countsAfter = await Promise.all([
      store.nodes.Podcast.getById(podcast.id),
      store.nodes.Episode.getById(episode.id),
      store.nodes.Segment.getById(segment.id),
      store.nodes.Tag.getById(tag.id),
    ]);
    expect(countsAfter).toEqual(countsBefore);
    expect(countsAfter.every((row) => row !== undefined)).toBe(true);
  });

  it("does not restrict deleting a PART directly out of its whole, even when the part itself declares onDelete: 'restrict'", async () => {
    // A dedicated fixture: unlike `buildPodcastGraph` (which declares
    // Episode `disconnect` specifically to keep this restrict question out
    // of its other tests), Episode here declares `restrict` — its ONLY
    // connected edge is the composition edge up to its whole.
    const RestrictEpisode = defineNode("RestrictEpisode", {
      schema: emptySchema,
    });
    const RestrictPodcast = defineNode("RestrictPodcast", {
      schema: emptySchema,
    });
    const restrictEpisodeOf = defineEdge("restrictEpisodeOf", {
      schema: emptySchema,
    });
    const graph = defineGraph({
      id: "cascade-restrict-part-direct-delete",
      nodes: {
        RestrictPodcast: { type: RestrictPodcast },
        RestrictEpisode: { type: RestrictEpisode, onDelete: "restrict" },
      },
      edges: {
        restrictEpisodeOf: {
          type: restrictEpisodeOf,
          from: [RestrictEpisode],
          to: [RestrictPodcast],
          cardinality: "one",
        },
      },
      ontology: [
        partOf(RestrictEpisode, RestrictPodcast, { via: restrictEpisodeOf }),
      ],
    });
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const podcast = await store.nodes.RestrictPodcast.create({});
    const episode = await store.nodes.RestrictEpisode.create({});
    const edge = await store.edges.restrictEpisodeOf.create(
      episode,
      podcast,
      {},
    );

    // MUTATION: drop the `!ctx.registry.isCompositionEdge(edge.kind)` filter
    // from `enforceNodeDeleteBehavior`'s restrict arm and this throws
    // `RestrictedDeleteError` instead of succeeding — the ruling is that a
    // part may always be deleted out of its whole.
    await store.nodes.RestrictEpisode.delete(episode.id);

    await expect(
      store.nodes.RestrictEpisode.getById(episode.id),
    ).resolves.toBeUndefined();
    // The whole is untouched: deleting a part directly must not touch it.
    await expect(
      store.nodes.RestrictPodcast.getById(podcast.id),
    ).resolves.toBeDefined();
    // MUTATION: revert the restrict arm's composition-edge cleanup (return
    // early once `restrictedEdges.length === 0` instead of deleting
    // `unconsumedEdges` first) and this resolves to the edge row instead of
    // `undefined` — the node tombstones while its composition edge survives
    // pointing at it, the exact state edges cannot be in.
    await expect(
      store.edges.restrictEpisodeOf.getById(edge.id),
    ).resolves.toBeUndefined();
  });

  it("cascades a restricting intermediate whole's OWN parts, then does not restrict on its OWN composition edge into its whole", async () => {
    // Episode here is BOTH a whole (of Segment, via segmentOf) and a part
    // (of Podcast, via episodeOf) — and, unlike `buildPodcastGraph`,
    // declares `onDelete: "restrict"` on itself: the exact "intermediate
    // whole that is itself a part" shape.
    const graph = defineGraph({
      id: "cascade-restrict-intermediate-whole",
      nodes: {
        Podcast: { type: Podcast },
        Episode: { type: Episode, onDelete: "restrict" },
        Segment: { type: Segment },
      },
      edges: {
        episodeOf: {
          type: episodeOf,
          from: [Episode],
          to: [Podcast],
          cardinality: "one",
        },
        segmentOf: {
          type: segmentOf,
          from: [Segment],
          to: [Episode],
          cardinality: "oneActive",
        },
      },
      ontology: [
        partOf(Episode, Podcast, { via: episodeOf }),
        partOf(Segment, Episode, { via: segmentOf }),
      ],
    });
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const podcast = await store.nodes.Podcast.create({ title: "p" });
    const episode = await store.nodes.Episode.create({ title: "e" });
    const segment = await store.nodes.Segment.create({});
    const episodeOfEdge = await store.edges.episodeOf.create(
      episode,
      podcast,
      {},
    );
    const segmentOfEdge = await store.edges.segmentOf.create(
      segment,
      episode,
      {},
    );

    // MUTATION: same as above — drop the composition-edge exclusion from
    // the restrict arm and this throws `RestrictedDeleteError` on the
    // upward `episodeOf` edge, even though the Segment cascade below it
    // already ran cleanly.
    await store.nodes.Episode.delete(episode.id);

    await expect(
      store.nodes.Episode.getById(episode.id),
    ).resolves.toBeUndefined();
    await expect(
      store.nodes.Segment.getById(segment.id),
    ).resolves.toBeUndefined();
    await expect(
      store.edges.segmentOf.getById(segmentOfEdge.id),
    ).resolves.toBeUndefined();
    // The outer whole is untouched.
    await expect(
      store.nodes.Podcast.getById(podcast.id),
    ).resolves.toBeDefined();
    // MUTATION: same as the direct-part-delete test above — revert the
    // restrict arm's composition-edge cleanup and this resolves to the
    // `episodeOf` edge row instead of `undefined`: Episode's OWN upward
    // composition edge into ITS whole, excluded from the restrict OBSTACLE
    // count, must still be removed alongside Episode's tombstone.
    await expect(
      store.edges.episodeOf.getById(episodeOfEdge.id),
    ).resolves.toBeUndefined();
  });

  it("cascades three levels of REFLEXIVE composition, terminated by the visited set", async () => {
    const SectionSchema = z.object({});
    const Section = defineNode("Section", { schema: SectionSchema });
    const containsSection = defineEdge("containsSection", {
      schema: emptySchema,
    });
    const graph = defineGraph({
      id: "cascade-reflexive",
      nodes: { Section: { type: Section } },
      edges: {
        containsSection: {
          type: containsSection,
          from: [Section],
          to: [Section],
          cardinality: "one",
        },
      },
      ontology: [
        partOf(Section, Section, { via: containsSection, partSide: "from" }),
      ],
    });
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const root = await store.nodes.Section.create({}, { id: "root" });
    const child = await store.nodes.Section.create({}, { id: "child" });
    const grandchild = await store.nodes.Section.create(
      {},
      { id: "grandchild" },
    );
    await store.edges.containsSection.create(child, root, {});
    await store.edges.containsSection.create(grandchild, child, {});

    await store.nodes.Section.delete(root.id);

    await expect(store.nodes.Section.getById(root.id)).resolves.toBeUndefined();
    await expect(
      store.nodes.Section.getById(child.id),
    ).resolves.toBeUndefined();
    await expect(
      store.nodes.Section.getById(grandchild.id),
    ).resolves.toBeUndefined();
  });

  it("Q2: resurrecting a soft-deleted whole restores the whole ALONE", async () => {
    const graph = buildPodcastGraph("cascade-resurrect-whole-alone");
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const podcast = await store.nodes.Podcast.create(
      { title: "My Show" },
      { id: "podcast-1" },
    );
    const episode = await store.nodes.Episode.create({ title: "Pilot" });
    await store.edges.episodeOf.create(episode, podcast, {});

    await store.nodes.Podcast.delete(podcast.id);
    await expect(
      store.nodes.Episode.getById(episode.id),
    ).resolves.toBeUndefined();

    const resurrected = await store.nodes.Podcast.create(
      { title: "Anything" },
      { id: "podcast-1" },
    );
    expect(resurrected.id).toBe(podcast.id);
    // The whole is back...
    await expect(
      store.nodes.Podcast.getById(podcast.id),
    ).resolves.toBeDefined();
    // ...but Episode was NOT revived alongside it: ending a whole's
    // ownership when the cascade ran is not undone by reopening the whole's
    // own currency.
    await expect(
      store.nodes.Episode.getById(episode.id),
    ).resolves.toBeUndefined();
  });

  it("refuses a composition whole's delete with CONSTRAINT_WRITE_FENCE_UNSUPPORTED on a backend with no interactive transaction, while a part-less kind still deletes normally", async () => {
    const graph = buildPodcastGraph("cascade-fence-unsupported");
    const sqlite = new Database(":memory:");
    for (const statement of generateSqliteDDL()) sqlite.exec(statement);
    const db = drizzle(sqlite);
    const backend = createSqliteBackend(db, {
      executionProfile: { transactionMode: "none", isSync: true },
    });
    try {
      const store = createStore(graph, backend);
      const podcast = await store.nodes.Podcast.create({ title: "p" });
      const episode = await store.nodes.Episode.create({ title: "e" });
      // Seeded through the raw backend, not `store.edges.episodeOf.create`:
      // `episodeOf` ALSO declares `cardinality: "one"`, an unrelated
      // constraint that would itself refuse on this transactionless
      // backend — this test is about the composition fence on DELETE, not
      // about edge-create's own fence.
      await backend.insertEdge({
        graphId: graph.id,
        kind: "episodeOf",
        id: "episode-of-seed",
        fromKind: "Episode",
        fromId: episode.id,
        toKind: "Podcast",
        toId: podcast.id,
        props: {},
      });

      // MUTATION: make `nodeDeleteConstraintProbe` always return `undefined`
      // (drop the composition classification) and this refusal disappears;
      // make `nodeDeleteNeedsConstraintFence` report `"edgeCardinality"` and
      // the `constraint` assertion below fails, since a cascading whole
      // delete is not remediable by declaring a cardinality on an edge.
      await expect(store.nodes.Podcast.delete(podcast.id)).rejects.toThrow(
        matchingObject({
          name: "ConfigurationError",
          details: matchingObject({
            code: "CONSTRAINT_WRITE_FENCE_UNSUPPORTED",
            constraint: "edgeComposition",
          }),
        }),
      );
      // Rollback proof: the whole and its part are untouched.
      await expect(
        store.nodes.Podcast.getById(podcast.id),
      ).resolves.toBeDefined();
      await expect(
        store.nodes.Episode.getById(episode.id),
      ).resolves.toBeDefined();

      // The declaration-property fast path: a part-less kind (Tag) needs no
      // fence and deletes normally on the SAME backend.
      const tag = await store.nodes.Tag.create({});
      await store.nodes.Tag.delete(tag.id);
      await expect(store.nodes.Tag.getById(tag.id)).resolves.toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it("population 'oneActive': reparenting a part frees it from its FORMER whole's cascade", async () => {
    const graph = buildPodcastGraph("cascade-onactive-reparent");
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const episodeA = await store.nodes.Episode.create({ title: "A" });
    const episodeB = await store.nodes.Episode.create({ title: "B" });
    const segment = await store.nodes.Segment.create({});
    const oldEdge = await store.edges.segmentOf.create(segment, episodeA, {});
    // Reparent: end the old window, then attach to the new episode. `oneActive`
    // (holderLiveness "liveAndActive") frees the slot the instant the window
    // ends, so the second create is not a cardinality conflict.
    await store.edges.segmentOf.update(
      oldEdge.id,
      {},
      { validTo: new Date().toISOString() },
    );
    await store.edges.segmentOf.create(segment, episodeB, {});

    await store.nodes.Episode.delete(episodeA.id);

    // Segment survived: the ended edge no longer counts under `oneActive`.
    await expect(
      store.nodes.Segment.getById(segment.id),
    ).resolves.toBeDefined();
  });

  it("population 'one': an ended-but-undeleted edge still counts against its whole's cascade", async () => {
    const graph = buildPodcastGraph("cascade-one-no-reparent");
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const podcastA = await store.nodes.Podcast.create({ title: "A" });
    const podcastB = await store.nodes.Podcast.create({ title: "B" });
    const episode = await store.nodes.Episode.create({ title: "e" });
    const oldEdge = await store.edges.episodeOf.create(episode, podcastA, {});
    await store.edges.episodeOf.update(
      oldEdge.id,
      {},
      { validTo: new Date().toISOString() },
    );

    // `one` (holderLiveness "live") never frees the slot on an ended window —
    // a second live edge from the same holder is still a conflict, proving a
    // `one` composition edge cannot be reparented behind its whole's back
    // without deleting the row outright. `episodeOf` is BOTH a declared
    // `cardinality: "one"` edge and a composition (`partOf`) realizing edge,
    // and the composition claim's write-fence priority (composition >
    // cardinality) reports its own, more specific `CompositionError` rather
    // than the generic `CardinalityError` an edge with no composition
    // declaration would raise for the identical "still held" liveness rule.
    await expect(
      store.edges.episodeOf.create(episode, podcastB, {}),
    ).rejects.toThrow(matchingObject({ name: "CompositionError" }));

    // Deleting the FORMER whole still cascades Episode away: the ended row
    // counts unconditionally under `population: "one"`.
    await store.nodes.Podcast.delete(podcastA.id);
    await expect(
      store.nodes.Episode.getById(episode.id),
    ).resolves.toBeUndefined();
  });
});

// ============================================================
// Fixture: Album -[hasTrack]-> Track -[noteOf]<- Note
//
// Every fixture above declares `partOf`, whose realizing edge always runs
// PART -> WHOLE, so `compositionPartSide` infers `"from"` in every case —
// R5's "via may run in either orientation" half is exercised by nothing.
// This fixture uses `hasPart`, whose realizing edge runs WHOLE -> PART, to
// infer `partSide: "to"` instead, and nests a `partOf`-oriented (`"from"`)
// grandchild under it so the closure walk crosses BOTH orientations in one
// cascade.
// ============================================================

const Album = defineNode("Album", {
  schema: z.object({ title: z.string().default("untitled") }),
});
const Track = defineNode("Track", { schema: emptySchema });
const Note = defineNode("Note", { schema: emptySchema });

const hasTrack = defineEdge("hasTrack", { schema: emptySchema });
const noteOf = defineEdge("noteOf", { schema: emptySchema });

function buildAlbumGraph(
  id: string,
  trackTargetCardinality: "one" | "oneActive",
) {
  return defineGraph({
    id,
    nodes: {
      Album: { type: Album },
      Track: { type: Track, onDelete: "disconnect" },
      Note: { type: Note },
    },
    edges: {
      hasTrack: {
        type: hasTrack,
        from: [Album],
        to: [Track],
        targetCardinality: trackTargetCardinality,
      },
      noteOf: { type: noteOf, from: [Note], to: [Track], cardinality: "one" },
    },
    ontology: [
      // WHOLE -> PART: infers `partSide: "to"` (Track is the edge's `to`).
      hasPart(Album, Track, { via: hasTrack }),
      // PART -> WHOLE: infers `partSide: "from"` (Note is the edge's `from`).
      partOf(Note, Track, { via: noteOf }),
    ],
  });
}

describe("composition cascade — to-oriented (hasPart) and mixed-orientation closures", () => {
  it("cascades a to-oriented (hasPart) whole to its part", async () => {
    const graph = buildAlbumGraph("cascade-haspart-one-level", "one");
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const album = await store.nodes.Album.create({ title: "Debut" });
    const track = await store.nodes.Track.create({});
    const hasTrackEdge = await store.edges.hasTrack.create(album, track, {});

    await store.nodes.Album.delete(album.id);

    await expect(store.nodes.Album.getById(album.id)).resolves.toBeUndefined();
    // MUTATION: in `planCompositionCascade`, make the `partSide === "to"`
    // resolution read `row.from_kind`/`row.from_id` instead of
    // `row.to_kind`/`row.to_id` (breaking only the to-oriented arm) and this
    // assertion flips — Track survives because the cascade resolves the
    // WHOLE, not the part, as the member to delete.
    await expect(store.nodes.Track.getById(track.id)).resolves.toBeUndefined();
    await expect(
      store.edges.hasTrack.getById(hasTrackEdge.id),
    ).resolves.toBeUndefined();
  });

  it("cascades a MIXED-orientation closure: a to-oriented whole with a from-oriented grandchild", async () => {
    const graph = buildAlbumGraph("cascade-haspart-mixed-orientation", "one");
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const album = await store.nodes.Album.create({ title: "Debut" });
    const track = await store.nodes.Track.create({});
    const note = await store.nodes.Note.create({});
    await store.edges.hasTrack.create(album, track, {});
    await store.edges.noteOf.create(note, track, {});

    await store.nodes.Album.delete(album.id);

    await expect(store.nodes.Album.getById(album.id)).resolves.toBeUndefined();
    await expect(store.nodes.Track.getById(track.id)).resolves.toBeUndefined();
    // The grandchild, reached through the SECOND (from-oriented) level of
    // the same walk, is cascaded too.
    await expect(store.nodes.Note.getById(note.id)).resolves.toBeUndefined();
  });

  it("targetCardinality 'oneActive': reparenting a to-oriented part frees it from its FORMER whole's cascade", async () => {
    const graph = buildAlbumGraph(
      "cascade-haspart-onactive-reparent",
      "oneActive",
    );
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const albumA = await store.nodes.Album.create({ title: "A" });
    const albumB = await store.nodes.Album.create({ title: "B" });
    const track = await store.nodes.Track.create({});
    const oldEdge = await store.edges.hasTrack.create(albumA, track, {});
    // Reparent: end the old window, then attach to the new album. `oneActive`
    // frees the slot the instant the window ends, so the second create is
    // not a target-cardinality conflict.
    await store.edges.hasTrack.update(
      oldEdge.id,
      {},
      { validTo: new Date().toISOString() },
    );
    await store.edges.hasTrack.create(albumB, track, {});

    await store.nodes.Album.delete(albumA.id);

    // Track survived: the ended edge no longer counts under `oneActive`.
    await expect(store.nodes.Track.getById(track.id)).resolves.toBeDefined();
  });

  it("targetCardinality 'one': an ended-but-undeleted to-oriented edge still counts against its whole's cascade", async () => {
    const graph = buildAlbumGraph("cascade-haspart-one-no-reparent", "one");
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const albumA = await store.nodes.Album.create({ title: "A" });
    const albumB = await store.nodes.Album.create({ title: "B" });
    const track = await store.nodes.Track.create({});
    const oldEdge = await store.edges.hasTrack.create(albumA, track, {});
    await store.edges.hasTrack.update(
      oldEdge.id,
      {},
      { validTo: new Date().toISOString() },
    );

    // `one` never frees the slot on an ended window — a second live edge
    // targeting the same Track is still a conflict, proving a `one`
    // composition edge cannot be reparented behind its whole's back without
    // deleting the row outright. `hasTrack` is BOTH a declared
    // `targetCardinality: "one"` edge and a composition (`hasPart`)
    // realizing edge, and the composition claim's write-fence priority
    // (composition > cardinality) reports its own, more specific
    // `CompositionError` rather than the generic `CardinalityError` an edge
    // with no composition declaration would raise for the identical "still
    // held" liveness rule.
    await expect(
      store.edges.hasTrack.create(albumB, track, {}),
    ).rejects.toThrow(matchingObject({ name: "CompositionError" }));

    // Deleting the FORMER whole still cascades Track away: the ended row
    // counts unconditionally under `targetCardinality: "one"`.
    await store.nodes.Album.delete(albumA.id);
    await expect(store.nodes.Track.getById(track.id)).resolves.toBeUndefined();
  });
});

/**
 * "Concurrent attach racing a cascade", translated through the write lock
 * `planCompositionCascade` reads under: the lock is taken BEFORE any row
 * read, so no interleaving other than "fully before" or "fully after" the
 * cascade's snapshot is reachable by ANY concurrent transaction — a
 * `store.transaction` attach either commits before the delete's transaction
 * opens (and the part is cascaded away with everything else) or after it
 * commits (and is refused because the whole no longer exists to attach to).
 * These two deterministic orderings are therefore an exact, non-flaky
 * translation of the race, rather than a best-effort timing simulation.
 *
 * A genuinely concurrent two-connection race against the SAME PostgreSQL
 * fence (two overlapping `pg_advisory_xact_lock` acquisitions on real
 * Postgres, not PGlite's single embedded connection) is a documented case
 * for the lead's Postgres lane: open a delete transaction, pause it
 * immediately after `planCompositionCascade` returns (before the cascade's
 * row work commits), start a concurrent attach transaction from a SECOND
 * connection, and assert it blocks on `typegraph:recorded-graph-write`
 * until the delete transaction ends — never observing a part half-attached
 * to an already-vanished whole.
 */
describe("composition cascade — attach ordering under the write lock", () => {
  it("an attach committed BEFORE the delete opens is included in the cascade", async () => {
    const graph = buildPodcastGraph("cascade-attach-before");
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const podcast = await store.nodes.Podcast.create({ title: "p" });
    const episode = await store.nodes.Episode.create({ title: "e" });
    // The attach — fully committed before the delete's own transaction opens.
    await store.edges.episodeOf.create(episode, podcast, {});

    await store.nodes.Podcast.delete(podcast.id);

    await expect(
      store.nodes.Episode.getById(episode.id),
    ).resolves.toBeUndefined();
  });

  it("an attach attempted AFTER the delete commits is refused, never orphaned", async () => {
    const graph = buildPodcastGraph("cascade-attach-after");
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const podcast = await store.nodes.Podcast.create({ title: "p" });
    const episode = await store.nodes.Episode.create({ title: "e" });
    await store.nodes.Podcast.delete(podcast.id);

    // The whole is gone; an attach reaching it afterward must be refused —
    // never silently accepted into a dangling composition edge.
    await expect(
      store.edges.episodeOf.create(episode, podcast, {}),
    ).rejects.toThrow();
    await expect(
      store.nodes.Podcast.getById(podcast.id),
    ).resolves.toBeUndefined();
  });
});

// ============================================================
// The cascade's EXPOSURE: the delete's hook context and receipt
// ============================================================

describe("composition cascade — cascadedParts exposure", () => {
  it("names the cascaded parts on the whole's onOperationEnd context, and nothing on onOperationStart", async () => {
    const graph = buildPodcastGraph("cascade-hook-exposure");
    const backend = createTestBackend();
    await createStoreWithSchema(graph, backend);

    const started: OperationHookContext[] = [];
    const ended: OperationHookContext[] = [];
    const store = createStore(graph, backend, {
      hooks: {
        onOperationStart: (ctx) => started.push(ctx),
        onOperationEnd: (ctx) => ended.push(ctx),
      },
    });

    const podcast = await store.nodes.Podcast.create({ title: "My Show" });
    const episode = await store.nodes.Episode.create({ title: "Pilot" });
    const segment = await store.nodes.Segment.create({});
    await store.edges.episodeOf.create(episode, podcast, {});
    await store.edges.segmentOf.create(segment, episode, {});

    started.length = 0;
    ended.length = 0;
    await store.nodes.Podcast.delete(podcast.id);

    // One event for the whole, exactly as before — the cascade adds no
    // per-part operation.
    expect(ended).toHaveLength(1);
    const endContext = requireDefined(ended[0]);
    expect(endContext.kind).toBe("Podcast");
    // MUTATION: drop `operationFacts: nodeDeleteOperationFacts` from
    // `executeNodeDelete`'s write-plan options
    // (src/store/operations/node-operations.ts) and this becomes undefined.
    expect(endContext.cascadedParts).toEqual([
      { kind: "Segment", id: segment.id },
      { kind: "Episode", id: episode.id },
    ]);
    // The START context cannot carry them: the cascade has not been planned.
    expect(requireDefined(started[0]).cascadedParts).toBeUndefined();
  });

  it("reports an empty cascade for a whole with no live parts", async () => {
    const graph = buildPodcastGraph("cascade-hook-exposure-empty");
    const backend = createTestBackend();
    await createStoreWithSchema(graph, backend);

    const ended: OperationHookContext[] = [];
    const store = createStore(graph, backend, {
      hooks: { onOperationEnd: (ctx) => ended.push(ctx) },
    });
    const podcast = await store.nodes.Podcast.create({ title: "Lonely" });
    ended.length = 0;

    await store.nodes.Podcast.delete(podcast.id);
    expect(requireDefined(ended[0]).cascadedParts).toEqual([]);
  });

  it("carries the same parts on the transaction receipt, and a hard delete reports them too", async () => {
    const graph = buildPodcastGraph("cascade-receipt-exposure");
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const podcast = await store.nodes.Podcast.create({ title: "My Show" });
    const episode = await store.nodes.Episode.create({ title: "Pilot" });
    const segment = await store.nodes.Segment.create({});
    await store.edges.episodeOf.create(episode, podcast, {});
    await store.edges.segmentOf.create(segment, episode, {});

    // MUTATION: drop the `ctx.recordCascadedParts?.(outcome.cascadedParts)`
    // call from `executeNodeHardDelete` and `cascadedParts` stays empty here
    // while the delete still removes both parts.
    const { receipt } = await store.transactionWithReceipt(async (tx) => {
      await tx.nodes.Podcast.hardDelete(podcast.id);
    });

    expect(receipt.cascadedParts).toEqual([
      { kind: "Segment", id: segment.id },
      { kind: "Episode", id: episode.id },
    ]);
    // The cascade is NOT folded into the write counters: one caller-issued
    // delete stays one write intent.
    expect(receipt.writes.nodes).toEqual({ Podcast: 1 });
    await expect(
      store.nodes.Segment.getById(segment.id),
    ).resolves.toBeUndefined();
  });

  it("reports every whole's cascade from a bulkDelete, in batch order", async () => {
    const graph = buildPodcastGraph("cascade-receipt-exposure-bulk");
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const first = await store.nodes.Podcast.create({ title: "First" });
    const firstEpisode = await store.nodes.Episode.create({ title: "1x01" });
    const firstSegment = await store.nodes.Segment.create({});
    await store.edges.episodeOf.create(firstEpisode, first, {});
    await store.edges.segmentOf.create(firstSegment, firstEpisode, {});

    const second = await store.nodes.Podcast.create({ title: "Second" });
    const secondEpisode = await store.nodes.Episode.create({ title: "2x01" });
    await store.edges.episodeOf.create(secondEpisode, second, {});

    // MUTATION: drop the `ctx.recordCascadedParts?.(outcome.cascadedParts)`
    // call from `executeNodeDeleteBatch`
    // (src/store/operations/node-operations.ts) — every part below is still
    // deleted and `receipt.cascadedParts` comes back `[]`, which is the
    // defect this test exists for: the batch path ran the cascade and
    // reported nothing.
    const { receipt } = await store.transactionWithReceipt(async (tx) => {
      await tx.nodes.Podcast.bulkDelete([first.id, second.id]);
    });

    // Leaf-first within each item, items in the batch's own order.
    expect(receipt.cascadedParts).toEqual([
      { kind: "Segment", id: firstSegment.id },
      { kind: "Episode", id: firstEpisode.id },
      { kind: "Episode", id: secondEpisode.id },
    ]);
    await expect(
      store.nodes.Segment.getById(firstSegment.id),
    ).resolves.toBeUndefined();
    await expect(
      store.nodes.Episode.getById(secondEpisode.id),
    ).resolves.toBeUndefined();
  });

  it("populates a tx.measure scope's receipt AND the outer one, attributed to the context the delete ran through", async () => {
    const graph = buildPodcastGraph("cascade-receipt-exposure-measured");
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const measured = await store.nodes.Podcast.create({ title: "Measured" });
    const measuredEpisode = await store.nodes.Episode.create({
      title: "In scope",
    });
    await store.edges.episodeOf.create(measuredEpisode, measured, {});

    const outer = await store.nodes.Podcast.create({ title: "Outer" });
    const outerEpisode = await store.nodes.Episode.create({
      title: "Out of scope",
    });
    await store.edges.episodeOf.create(outerEpisode, outer, {});

    // MUTATION: build the measured scope by wrapping the outer context's
    // collections a second time instead of rebuilding the write surface
    // against the recorder chain (`#attachMeasure`, src/store/store.ts) — the
    // scope's write COUNTERS still come out right, while the delete's
    // cascade reaches the transaction's recorder alone and
    // `scope.receipt.cascadedParts` comes back `[]`.
    const { receipt, result } = await store.transactionWithReceipt(
      async (tx) => {
        const scope = await tx.measure(async (scoped) => {
          await scoped.nodes.Podcast.delete(measured.id);
        });
        // Issued through the OUTER context while no scope is open: attribution
        // is by context, so this cascade belongs to the transaction alone.
        await tx.nodes.Podcast.delete(outer.id);
        return scope;
      },
    );

    expect(result.receipt.cascadedParts).toEqual([
      { kind: "Episode", id: measuredEpisode.id },
    ]);
    expect(result.receipt.writes.nodes).toEqual({ Podcast: 1 });
    // The outer receipt sees both cascades, in the order they ran.
    expect(receipt.cascadedParts).toEqual([
      { kind: "Episode", id: measuredEpisode.id },
      { kind: "Episode", id: outerEpisode.id },
    ]);
  });

  it("populates a measured scope's receipt for a delete issued through the transaction's internal delete port", async () => {
    const graph = buildPodcastGraph("cascade-receipt-exposure-runtime-port");
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const podcast = await store.nodes.Podcast.create({ title: "Ported" });
    const episode = await store.nodes.Episode.create({ title: "Pilot" });
    await store.edges.episodeOf.create(episode, podcast, {});

    // `TRANSACTION_RUNTIME`'s delete port is how a caller already inside a
    // transaction reaches a non-default `NodeDeletePolicy` (merge apply is the
    // one today). It carries its own node operation context, so a scope that
    // rebuilds the write surface but inherits the OUTER port runs the delete
    // against the outer context — right counters, no cascade.
    //
    // MUTATION: drop the `[TRANSACTION_RUNTIME]` overlay from `#attachMeasure`
    // (src/store/store.ts) so the scoped context keeps the outer port — the
    // scope's `cascadedParts` then comes back `[]` while the outer receipt
    // still lists the episode.
    const { receipt, result } = await store.transactionWithReceipt((tx) =>
      tx.measure((scoped) =>
        transactionDeleteNodeWithPolicy(scoped, {
          kind: "Podcast",
          id: podcast.id,
        }),
      ),
    );

    expect(result.receipt.cascadedParts).toEqual([
      { kind: "Episode", id: episode.id },
    ]);
    expect(receipt.cascadedParts).toEqual([
      { kind: "Episode", id: episode.id },
    ]);
  });

  it("leaves a measured scope's cascadedParts empty when the delete runs outside it", async () => {
    const graph = buildPodcastGraph("cascade-receipt-exposure-unmeasured");
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const podcast = await store.nodes.Podcast.create({ title: "Outer only" });
    const episode = await store.nodes.Episode.create({ title: "Pilot" });
    await store.edges.episodeOf.create(episode, podcast, {});

    // MUTATION: attribute the cascade by TIMING rather than by context (for
    // example, push the scope recorder onto a "currently measuring" stack for
    // the duration of the callback) — this delete, issued through `tx` while
    // the scope is open, then leaks into the scope's receipt.
    const { receipt, result } = await store.transactionWithReceipt(
      async (tx) => {
        const scope = await tx.measure(async () => {
          await tx.nodes.Podcast.delete(podcast.id);
        });
        return scope;
      },
    );

    expect(result.receipt.cascadedParts).toEqual([]);
    expect(receipt.cascadedParts).toEqual([
      { kind: "Episode", id: episode.id },
    ]);
  });

  it("leaves cascadedParts empty on a transaction that deletes no composition whole", async () => {
    const graph = buildPodcastGraph("cascade-receipt-exposure-none");
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const { receipt } = await store.transactionWithReceipt(async (tx) => {
      await tx.nodes.Tag.create({});
    });
    expect(receipt.cascadedParts).toEqual([]);
  });
});
