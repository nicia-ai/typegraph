/**
 * valid_to-expiry liveness.
 *
 * Every other liveness suite excludes a row by TOMBSTONING it (`deleted_at`).
 * This one excludes rows by VALID-TIME EXPIRY instead: a node/edge whose
 * `valid_to` has already passed is invisible to a current-mode read, yet — and
 * this is what separates "expired" from "deleted" — an `asOf` read positioned
 * before the expiry still sees it (a tombstone stays hidden even under `asOf`).
 *
 * The expiry check lives in four independent places, one per read surface, and
 * this suite exercises all four:
 *   - `compileTemporalFilter` (query builder, `degree`, `neighbors`)
 *   - `buildTemporalConditions` (collection `find` / `count`)
 *   - the store's in-JS row matcher (`getById`)
 *   - `liveNodeIdsSubquery` (fulltext / vector / hybrid facade search)
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  embedding,
  searchable,
} from "../src";
import { type GraphBackend } from "../src/backend/types";
import { createInitializedStore, createTestBackend } from "./test-utils";

// A clean, well-separated timeline. The expired row is valid across
// [CREATED, EXPIRY); "now" (real wall clock) is far past EXPIRY, so the row
// has expired. BEFORE_EXPIRY sits inside the window — an `asOf` read there
// still sees the row.
const CREATED = "2020-01-01T00:00:00.000Z";
const BEFORE_EXPIRY = "2020-06-01T00:00:00.000Z";
const EXPIRY = "2021-01-01T00:00:00.000Z";
const FUTURE = "2030-01-01T00:00:00.000Z";

const QUERY_VECTOR: readonly number[] = [1, 0, 0];
const FULLTEXT_TERM = "signal";

const Person = defineNode("Person", {
  schema: z.object({
    name: searchable({ language: "english" }),
    embedding: embedding(3),
  }),
});

const knows = defineEdge("knows", { schema: z.object({}) });

const graph = defineGraph({
  id: "valid_to_expiry",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

describe("valid_to-expiry liveness", () => {
  let backend: GraphBackend;
  let store: Awaited<ReturnType<typeof createInitializedStore<typeof graph>>>;
  let vectorSupported: boolean;

  beforeEach(async () => {
    backend = createTestBackend();
    store = await createInitializedStore(graph, backend);
    vectorSupported = backend.capabilities.vector?.supported === true;
  });

  // All three carry the same searchable term and the same vector, so nothing
  // but validity distinguishes them to a ranked search — an expired row that
  // slips the filter would rank right alongside the live ones.
  async function seedNodes() {
    const open = await store.nodes.Person.create(
      { name: `${FULLTEXT_TERM} open`, embedding: QUERY_VECTOR },
      { id: "open", validFrom: CREATED },
    );
    const future = await store.nodes.Person.create(
      { name: `${FULLTEXT_TERM} future`, embedding: QUERY_VECTOR },
      { id: "future", validFrom: CREATED, validTo: FUTURE },
    );
    const expired = await store.nodes.Person.create(
      { name: `${FULLTEXT_TERM} expired`, embedding: QUERY_VECTOR },
      { id: "expired", validFrom: CREATED, validTo: EXPIRY },
    );
    return { open, future, expired };
  }

  // Hub with two outgoing `knows` edges: one open-ended (live) and one whose
  // valid_to has passed (expired). Node validity is held constant (all three
  // are open from CREATED) so only edge expiry drives the assertions.
  async function seedEdges(): Promise<void> {
    const hub = await store.nodes.Person.create(
      { name: "hub", embedding: QUERY_VECTOR },
      { id: "hub", validFrom: CREATED },
    );
    const liveTarget = await store.nodes.Person.create(
      { name: "live", embedding: QUERY_VECTOR },
      { id: "live", validFrom: CREATED },
    );
    const expiredTarget = await store.nodes.Person.create(
      { name: "gone", embedding: QUERY_VECTOR },
      { id: "gone", validFrom: CREATED },
    );
    await store.edges.knows.create(hub, liveTarget, {}, { validFrom: CREATED });
    await store.edges.knows.create(
      hub,
      expiredTarget,
      {},
      { validFrom: CREATED, validTo: EXPIRY },
    );
  }

  describe("node reads", () => {
    let seeded: Awaited<ReturnType<typeof seedNodes>>;

    beforeEach(async () => {
      seeded = await seedNodes();
    });

    it("query builder: current mode hides the expired node", async () => {
      const ids = await store
        .query()
        .from("Person", "p")
        .select((ctx) => ctx.p.id)
        .execute();
      expect(new Set(ids)).toEqual(new Set(["open", "future"]));
    });

    it("collection find(): current mode hides the expired node", async () => {
      const rows = await store.nodes.Person.find();
      expect(new Set(rows.map((row) => row.id))).toEqual(
        new Set(["open", "future"]),
      );
    });

    it("collection count(): the expired node is not counted", async () => {
      expect(await store.nodes.Person.count()).toBe(2);
    });

    it("collection getById(): the expired node resolves to undefined", async () => {
      const expiredNode = await store.nodes.Person.getById(seeded.expired.id);
      const openNode = await store.nodes.Person.getById(seeded.open.id);
      const futureNode = await store.nodes.Person.getById(seeded.future.id);
      expect(expiredNode).toBeUndefined();
      expect(openNode?.id).toBe("open");
      expect(futureNode?.id).toBe("future");
    });

    it("fulltext search: the expired node never ranks", async () => {
      const hits = await store.search.fulltext("Person", {
        query: FULLTEXT_TERM,
        limit: 10,
      });
      const ids = hits.map((hit) => hit.node.id);
      expect(ids).toContain("open");
      expect(ids).toContain("future");
      expect(ids).not.toContain("expired");
    });

    it("vector search: the expired node never ranks", async () => {
      if (!vectorSupported) return;
      const hits = await store.search.vector("Person", {
        fieldPath: "embedding",
        queryEmbedding: QUERY_VECTOR,
        limit: 10,
      });
      const ids = hits.map((hit) => hit.node.id);
      expect(ids).toContain("open");
      expect(ids).toContain("future");
      expect(ids).not.toContain("expired");
    });

    it("hybrid search: the expired node never ranks", async () => {
      if (!vectorSupported) return;
      const hits = await store.search.hybrid("Person", {
        vector: { fieldPath: "embedding", queryEmbedding: QUERY_VECTOR },
        fulltext: { query: FULLTEXT_TERM },
        limit: 10,
      });
      const ids = hits.map((hit) => hit.node.id);
      expect(ids).toContain("open");
      expect(ids).toContain("future");
      expect(ids).not.toContain("expired");
    });

    it("asOf BEFORE the expiry still sees the row (expired ≠ deleted)", async () => {
      // The row is valid across [CREATED, EXPIRY); an asOf read inside that
      // window resolves it — the property a tombstone (hidden even under asOf)
      // could never satisfy.
      const asOf = { temporalMode: "asOf", asOf: BEFORE_EXPIRY } as const;

      const found = await store.nodes.Person.find(undefined, asOf);
      expect(found.map((row) => row.id)).toContain("expired");

      const expiredAtBefore = await store.nodes.Person.getById(
        seeded.expired.id,
        asOf,
      );
      expect(expiredAtBefore?.id).toBe("expired");

      const queried = await store
        .query()
        .from("Person", "p")
        .temporal("asOf", BEFORE_EXPIRY)
        .select((ctx) => ctx.p.id)
        .execute();
      expect(queried).toContain("expired");
    });

    it("includeEnded surfaces the expired row (excluded by validity, not deletion)", async () => {
      const found = await store.nodes.Person.find(undefined, {
        temporalMode: "includeEnded",
      });
      expect(new Set(found.map((row) => row.id))).toEqual(
        new Set(["open", "future", "expired"]),
      );
      expect(
        await store.nodes.Person.count({ temporalMode: "includeEnded" }),
      ).toBe(3);
    });
  });

  describe("edge algorithms", () => {
    beforeEach(async () => {
      await seedEdges();
    });

    it("degree(): current mode excludes the edge whose valid_to has passed", async () => {
      const current = await store.algorithms.degree("hub", {
        edges: ["knows"],
        direction: "out",
      });
      expect(current).toBe(1);

      const ended = await store.algorithms.degree("hub", {
        edges: ["knows"],
        direction: "out",
        temporalMode: "includeEnded",
      });
      expect(ended).toBe(2);
    });

    it("neighbors(): current mode drops the expired edge's target", async () => {
      const current = await store.algorithms.neighbors("hub", {
        edges: ["knows"],
      });
      expect(current.map((row) => row.id)).toEqual(["live"]);

      const ended = await store.algorithms.neighbors("hub", {
        edges: ["knows"],
        temporalMode: "includeEnded",
      });
      expect(new Set(ended.map((row) => row.id))).toEqual(
        new Set(["live", "gone"]),
      );
    });

    it("asOf BEFORE the expiry still traverses the edge (expired ≠ deleted)", async () => {
      // At BEFORE_EXPIRY both edges are valid, so degree counts both and the
      // expired edge's target is reachable — impossible for a deleted edge.
      const degree = await store.algorithms.degree("hub", {
        edges: ["knows"],
        direction: "out",
        temporalMode: "asOf",
        asOf: BEFORE_EXPIRY,
      });
      expect(degree).toBe(2);

      const neighbors = await store.algorithms.neighbors("hub", {
        edges: ["knows"],
        temporalMode: "asOf",
        asOf: BEFORE_EXPIRY,
      });
      expect(neighbors.map((row) => row.id)).toContain("gone");
    });
  });
});
