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
 *    layer), proving the cascade end to end.
 *
 * MUTATION CHECKS recorded in the lane's load-bearing note
 * (`lane-Ec2-load-bearing.md`).
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
  partOf,
} from "../src";
import { generateSqliteDDL } from "../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { type EdgeRow, type GraphBackend } from "../src/backend/types";
import { buildKindRegistry } from "../src/registry";
import {
  compositionEdgeCounts,
  planCompositionCascade,
} from "../src/store/operations/composition-cascade";
import { uncapturedGraphWriteLock } from "../src/store/recorded-capture/clock";
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
    // MUTATION: drop the `.toReversed()` in `planCompositionCascade` and this
    // assertion flips to [Episode, Segment] (BFS discovery order).
    expect(plan.members.map((member) => member.kind)).toEqual([
      "Segment",
      "Episode",
    ]);
    expect(plan.consumedEdgeIds.size).toBe(2);
  });

  it("throws CompilerInvariantError on an unreachable revisit rather than truncating", async () => {
    const graph = buildPodcastGraph("cascade-plan-revisit");
    const registry = buildKindRegistry(graph);
    // A fake backend whose rows admit the SAME (kind, id) member twice —
    // the shape the real acyclicity fence makes unreachable (composition
    // cycles are refused at declaration time) — hand-built here to reach the
    // throw directly rather than depending on an unreachable real fixture.
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
        name: "CompilerInvariantError",
        code: "COMPILER_INVARIANT_ERROR",
      }),
    );
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
      // (drop the composition classification) and this refusal disappears.
      await expect(store.nodes.Podcast.delete(podcast.id)).rejects.toThrow(
        matchingObject({
          name: "ConfigurationError",
          details: matchingObject({
            code: "CONSTRAINT_WRITE_FENCE_UNSUPPORTED",
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
    // a second live edge from the same holder is still a cardinality
    // conflict, proving a `one` composition edge cannot be reparented behind
    // its whole's back without deleting the row outright.
    await expect(
      store.edges.episodeOf.create(episode, podcastB, {}),
    ).rejects.toThrow(matchingObject({ name: "CardinalityError" }));

    // Deleting the FORMER whole still cascades Episode away: the ended row
    // counts unconditionally under `population: "one"`.
    await store.nodes.Podcast.delete(podcastA.id);
    await expect(
      store.nodes.Episode.getById(episode.id),
    ).resolves.toBeUndefined();
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
