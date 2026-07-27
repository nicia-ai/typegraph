import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  defineEdge,
  defineGraph,
  defineNode,
  ValidationError,
} from "../../../src";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

/**
 * Cross-backend coverage for `bulkFindFrom` / `bulkFindTo` — the set-valued
 * form of `findFrom` / `findTo`.
 *
 * The contract these tests defend is "the same read, one statement": every
 * case that asserts a result also asserts it against the singleton method it
 * widens, so a dialect that filtered, ordered, or grouped the set form
 * differently would fail here rather than in one backend's private suite.
 */
export function registerBulkFindEndpointIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("bulkFindFrom / bulkFindTo", () => {
    const PAST_VALID_FROM = "2019-01-01T00:00:00.000Z";
    const PAST_VALID_TO = "2020-01-01T00:00:00.000Z";
    const DURING_PAST = "2019-06-01T00:00:00.000Z";

    it("groups each source's edges by input position", async () => {
      const { store, alice, bob, dave } = await seedKnowsGraph(context);

      const results = await store.edges.knows.bulkFindFrom([alice, bob, dave]);

      expect(results).toHaveLength(3);
      expect(results[0]?.map((edge) => edge.since).toSorted()).toEqual([
        "2021",
        "2022",
      ]);
      expect(results[1]?.map((edge) => edge.since)).toEqual(["2023"]);
      // A source with no edges gets its own empty bucket, not a missing slot.
      expect(results[2]).toEqual([]);
      for (const bucket of results) {
        for (const edge of bucket) expect(edge.kind).toBe("knows");
      }
    });

    it("returns exactly what findFrom returns, source by source", async () => {
      const { store, alice, bob, dave } = await seedKnowsGraph(context);
      const sources = [alice, bob, dave];

      const bulk = await store.edges.knows.bulkFindFrom(sources);
      const singles = [];
      for (const source of sources) {
        singles.push(await store.edges.knows.findFrom(source));
      }

      expect(bulk.map((bucket) => bucket.map((edge) => edge.id))).toEqual(
        singles.map((bucket) => bucket.map((edge) => edge.id)),
      );
    });

    it("returns exactly what findTo returns, target by target", async () => {
      const { store, alice, bob, carol } = await seedKnowsGraph(context);
      const targets = [carol, bob, alice];

      const bulk = await store.edges.knows.bulkFindTo(targets);
      const singles = [];
      for (const target of targets) {
        singles.push(await store.edges.knows.findTo(target));
      }

      expect(bulk.map((bucket) => bucket.map((edge) => edge.id))).toEqual(
        singles.map((bucket) => bucket.map((edge) => edge.id)),
      );
      expect(bulk[0]).toHaveLength(2); // Carol is known by Alice and Bob
      expect(bulk[2]).toEqual([]); // nobody knows Alice
    });

    it("returns an empty result for empty input without reading", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const spy = vi.spyOn(backend, "findEdgesByKind");
      try {
        expect(await store.edges.knows.bulkFindFrom([])).toEqual([]);
        expect(await store.edges.knows.bulkFindTo([])).toEqual([]);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("reads a whole page of sources in one backend call", async () => {
      const { store, alice, bob, carol, dave } = await seedKnowsGraph(context);
      const backend = context.getBackend();

      const spy = vi.spyOn(backend, "findEdgesByKind");
      try {
        await store.edges.knows.bulkFindFrom([alice, bob, carol, dave]);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });

    it("gives repeated inputs independent copies of the same edge set", async () => {
      const { store, alice } = await seedKnowsGraph(context);

      const [first, second] = await store.edges.knows.bulkFindFrom([
        alice,
        alice,
      ]);

      expect(first?.map((edge) => edge.id)).toEqual(
        second?.map((edge) => edge.id),
      );
      expect(first).not.toBe(second);
    });

    it("caps each source with limitPerInput, keeping the leading edges", async () => {
      const { store, alice, bob } = await seedKnowsGraph(context);
      const aliceEdges = await store.edges.knows.findFrom(alice);

      const capped = await store.edges.knows.bulkFindFrom([alice, bob], {
        limitPerInput: 1,
      });

      expect(capped.map((bucket) => bucket.length)).toEqual([1, 1]);
      expect(capped[0]?.[0]?.id).toBe(aliceEdges[0]?.id);
    });

    it("rejects a limitPerInput that is not a positive integer", async () => {
      const { store, alice } = await seedKnowsGraph(context);

      await expect(
        store.edges.knows.bulkFindFrom([alice], { limitPerInput: 0 }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        store.edges.knows.bulkFindTo([alice], { limitPerInput: 1.5 }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("excludes soft-deleted edges exactly like findFrom", async () => {
      const { store, alice, bob } = await seedKnowsGraph(context);
      const [firstEdge] = await store.edges.knows.findFrom(alice);
      await store.edges.knows.delete(requireDefined(firstEdge).id);

      const [live] = await store.edges.knows.bulkFindFrom([alice]);
      const liveSingleton = await store.edges.knows.findFrom(alice);
      expect(live?.map((edge) => edge.id)).toEqual(
        liveSingleton.map((edge) => edge.id),
      );

      const tombstones = { temporalMode: "includeTombstones" } as const;
      const tombstoned = await store.edges.knows.bulkFindFrom(
        [alice, bob],
        tombstones,
      );
      const tombstonedSingleton = await store.edges.knows.findFrom(
        alice,
        tombstones,
      );
      expect(tombstoned[0]?.map((edge) => edge.id)).toEqual(
        tombstonedSingleton.map((edge) => edge.id),
      );
    });

    it("reads a past coordinate exactly like findFrom", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const carol = await store.nodes.Person.create({ name: "Carol" });
      await store.edges.knows.create(
        alice,
        bob,
        { since: "past" },
        { validFrom: PAST_VALID_FROM, validTo: PAST_VALID_TO },
      );
      await store.edges.knows.create(alice, carol, { since: "now" });

      const past = { temporalMode: "asOf", asOf: DURING_PAST } as const;
      const [bulkPast] = await store.edges.knows.bulkFindFrom([alice], past);
      const singlePast = await store.edges.knows.findFrom(alice, past);

      expect(bulkPast?.map((edge) => edge.since)).toEqual(["past"]);
      expect(bulkPast?.map((edge) => edge.id)).toEqual(
        singlePast.map((edge) => edge.id),
      );

      // The current coordinate sees the other edge and not the expired one.
      const [bulkNow] = await store.edges.knows.bulkFindFrom([alice]);
      expect(bulkNow?.map((edge) => edge.since)).toEqual(["now"]);
    });

    it("honors a StoreView's pinned coordinate", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      await store.edges.knows.create(
        alice,
        bob,
        { since: "past" },
        { validFrom: PAST_VALID_FROM, validTo: PAST_VALID_TO },
      );

      const past = store.asOf(DURING_PAST);
      const [pinned] = await past.edges.knows.bulkFindFrom([alice]);
      expect(pinned?.map((edge) => edge.since)).toEqual(["past"]);

      const [live] = await store.edges.knows.bulkFindFrom([alice]);
      expect(live).toEqual([]);
    });

    it("fans out over more than one endpoint kind in one call", async () => {
      const Author = defineNode("Author", {
        schema: z.object({ name: z.string() }),
      });
      const Studio = defineNode("Studio", {
        schema: z.object({ name: z.string() }),
      });
      const Work = defineNode("Work", {
        schema: z.object({ name: z.string() }),
      });
      const produced = defineEdge("produced", {
        schema: z.object({ year: z.string() }),
      });
      const graph = defineGraph({
        id: "bulk_endpoint_mixed_kinds",
        nodes: {
          Author: { type: Author },
          Studio: { type: Studio },
          Work: { type: Work },
        },
        edges: {
          produced: { type: produced, from: [Author, Studio], to: [Work] },
        },
      });

      const store = await context.createStore(graph);
      const author = await store.nodes.Author.create({ name: "Ada" });
      const studio = await store.nodes.Studio.create({ name: "Bell" });
      const work = await store.nodes.Work.create({ name: "Notes" });
      await store.edges.produced.create(author, work, { year: "1843" });
      await store.edges.produced.create(studio, work, { year: "1925" });

      const results = await store.edges.produced.bulkFindFrom([author, studio]);

      expect(results[0]?.map((edge) => edge.year)).toEqual(["1843"]);
      expect(results[1]?.map((edge) => edge.year)).toEqual(["1925"]);
    });

    it("splits an endpoint set that exceeds the bound-parameter budget", async () => {
      const { store, alice, bob } = await seedKnowsGraph(context);
      const backend = context.getBackend();

      // Sized off the backend's own budget so the read is guaranteed to span
      // more than one statement on whichever engine runs it. The absent ids
      // contribute nothing but binds — the two real sources must still come
      // back complete, and in the right buckets, across the chunk boundary.
      const budget = backend.capabilities.maxBindParameters ?? 999;
      const absent = Array.from(
        { length: budget + 1 },
        (_, index) => ({ kind: "Person", id: `absent-${index}` }) as const,
      );

      const results = await store.edges.knows.bulkFindFrom([
        ...absent,
        alice,
        bob,
      ]);

      expect(results).toHaveLength(absent.length + 2);
      expect(
        results
          .at(-2)
          ?.map((edge) => edge.since)
          .toSorted(),
      ).toEqual(["2021", "2022"]);
      expect(results.at(-1)?.map((edge) => edge.since)).toEqual(["2023"]);
      expect(results.filter((bucket) => bucket.length > 0)).toHaveLength(2);
    });

    describe("endpoint-set parameter validation", () => {
      it("rejects a scalar endpoint id combined with its id set", async () => {
        const store = context.getStore();
        const backend = context.getBackend();

        await expect(
          backend.findEdgesByKind({
            graphId: store.graphId,
            kind: "knows",
            fromId: "a",
            fromIds: ["a", "b"],
          }),
        ).rejects.toBeInstanceOf(ConfigurationError);

        await expect(
          backend.findEdgesByKind({
            graphId: store.graphId,
            kind: "knows",
            toId: "a",
            toIds: ["a", "b"],
          }),
        ).rejects.toBeInstanceOf(ConfigurationError);
      });

      it("rejects fanning out both endpoints at once", async () => {
        const store = context.getStore();
        const backend = context.getBackend();

        await expect(
          backend.findEdgesByKind({
            graphId: store.graphId,
            kind: "knows",
            fromIds: ["a"],
            toIds: ["b"],
          }),
        ).rejects.toBeInstanceOf(ConfigurationError);
      });

      it("rejects a global limit / offset / after beside an id set", async () => {
        const store = context.getStore();
        const backend = context.getBackend();

        for (const slice of [
          { limit: 10 },
          { offset: 5 },
          { orderBy: "id", after: "x" },
        ] as const) {
          await expect(
            backend.findEdgesByKind({
              graphId: store.graphId,
              kind: "knows",
              fromIds: ["a"],
              ...slice,
            }),
          ).rejects.toBeInstanceOf(ConfigurationError);
        }
      });

      it("rejects limitPerEndpoint without an id set", async () => {
        const store = context.getStore();
        const backend = context.getBackend();

        await expect(
          backend.findEdgesByKind({
            graphId: store.graphId,
            kind: "knows",
            fromId: "a",
            limitPerEndpoint: 1,
          }),
        ).rejects.toBeInstanceOf(ConfigurationError);
      });
    });
  });
}

/** Alice knows Bob and Carol, Bob knows Carol, Dave knows nobody. */
async function seedKnowsGraph(context: IntegrationTestContext) {
  const store = context.getStore();
  const [alice, bob, carol, dave] = await Promise.all([
    store.nodes.Person.create({ name: "Alice" }),
    store.nodes.Person.create({ name: "Bob" }),
    store.nodes.Person.create({ name: "Carol" }),
    store.nodes.Person.create({ name: "Dave" }),
  ]);
  await store.edges.knows.create(alice, bob, { since: "2021" });
  await store.edges.knows.create(alice, carol, { since: "2022" });
  await store.edges.knows.create(bob, carol, { since: "2023" });
  return { store, alice, bob, carol, dave };
}
