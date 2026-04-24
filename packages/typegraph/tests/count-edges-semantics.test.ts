/**
 * Runtime semantic tests for countEdges / countDistinctEdges.
 *
 * The shipped compiler fast path treats `count(targetAlias)` and
 * `countEdges(edgeAlias)` as two distinct aggregators:
 *
 *   - `count(targetAlias)` joins to the target node table and respects
 *     the target's temporal window — only live targets are counted.
 *   - `countEdges(edgeAlias)` counts edges directly, skipping the node
 *     join. An edge to a target whose `validTo` has passed still counts,
 *     because the edge itself is still live.
 *
 * These tests exercise the distinction against a real SQLite backend
 * using a target node whose `validTo` is in the past.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  count,
  countDistinctEdges,
  countEdges,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  field,
} from "../src";
import type { GraphBackend } from "../src/backend/types";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows");

const graph = defineGraph({
  id: "count_edges_semantics",
  nodes: { Person: { type: Person } },
  edges: {
    knows: {
      type: knows,
      from: [Person],
      to: [Person],
      cardinality: "many",
    },
  },
});

describe("countEdges vs count(target) semantics", () => {
  let backend: GraphBackend;
  let store: ReturnType<typeof createStore<typeof graph>>;

  /**
   * Canonical fixture for the two-aggregator comparison: Alice knows
   * Bob (both live) and Eve (temporally expired via `validTo` in the
   * past, while the Alice→Eve edge itself remains live). This is the
   * exact state where `count(target)` and `countEdges` produce
   * different answers.
   */
  const PAST_TIMESTAMP = "2020-01-01T00:00:00.000Z";
  async function seedAliceWithExpiredEveFriend(): Promise<void> {
    await store.nodes.Person.create({ name: "Alice" }, { id: "alice" });
    await store.nodes.Person.create({ name: "Bob" }, { id: "bob" });
    await store.nodes.Person.create(
      { name: "Eve" },
      { id: "eve", validTo: PAST_TIMESTAMP },
    );
    await store.edges.knows.create(
      { kind: "Person", id: "alice" },
      { kind: "Person", id: "bob" },
      {},
    );
    await store.edges.knows.create(
      { kind: "Person", id: "alice" },
      { kind: "Person", id: "eve" },
      {},
    );
  }

  beforeEach(() => {
    backend = createTestBackend();
    store = createStore(graph, backend);
  });

  it("counts edges to a validTo-expired target differently from count(target)", async () => {
    await seedAliceWithExpiredEveFriend();

    const liveTargets = await store
      .query()
      .from("Person", "p")
      .whereNode("p", (person) => person.id.eq("alice"))
      .optionalTraverse("knows", "e", { expand: "none" })
      .to("Person", "friend")
      .groupByNode("p")
      .aggregate({
        name: field("p", "name"),
        liveFriendCount: count("friend"),
      })
      .execute();
    expect(liveTargets).toHaveLength(1);
    // Eve is expired, so only the Alice→Bob relationship counts as live.
    expect(liveTargets[0]!.liveFriendCount).toBe(1);

    const edgeCount = await store
      .query()
      .from("Person", "p")
      .whereNode("p", (person) => person.id.eq("alice"))
      .optionalTraverse("knows", "e", { expand: "none" })
      .to("Person", "friend")
      .groupByNode("p")
      .aggregate({
        name: field("p", "name"),
        totalKnows: countEdges("e"),
      })
      .execute();
    expect(edgeCount).toHaveLength(1);
    // Both Alice→Bob and Alice→Eve edges are live regardless of Eve's state.
    expect(edgeCount[0]!.totalKnows).toBe(2);
  });

  it("mixes count(target) and countEdges in a single aggregate", async () => {
    await seedAliceWithExpiredEveFriend();

    const rows = await store
      .query()
      .from("Person", "p")
      .whereNode("p", (person) => person.id.eq("alice"))
      .optionalTraverse("knows", "e", { expand: "none" })
      .to("Person", "friend")
      .groupByNode("p")
      .aggregate({
        name: field("p", "name"),
        liveFriends: count("friend"),
        totalEdges: countEdges("e"),
        distinctEdges: countDistinctEdges("e"),
      })
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.liveFriends).toBe(1);
    expect(rows[0]!.totalEdges).toBe(2);
    expect(rows[0]!.distinctEdges).toBe(2);
  });

  it("countEdges returns 0 for users with no outgoing edges", async () => {
    await store.nodes.Person.create({ name: "Solo" }, { id: "solo" });

    const rows = await store
      .query()
      .from("Person", "p")
      .whereNode("p", (person) => person.id.eq("solo"))
      .optionalTraverse("knows", "e", { expand: "none" })
      .to("Person", "friend")
      .groupByNode("p")
      .aggregate({
        name: field("p", "name"),
        followCount: countEdges("e"),
      })
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.followCount).toBe(0);
  });

  it("countEdges respects a whereNode predicate on the target alias", async () => {
    // Alice knows Bob (name matches "Bob") and Eve (name does not).
    // countEdges with a whereNode predicate on `friend` should count
    // only the Alice→Bob edge — the predicate must constrain the
    // aggregate, not just the projection.
    await store.nodes.Person.create({ name: "Alice" }, { id: "alice" });
    await store.nodes.Person.create({ name: "Bob" }, { id: "bob" });
    await store.nodes.Person.create({ name: "Eve" }, { id: "eve" });
    await store.edges.knows.create(
      { kind: "Person", id: "alice" },
      { kind: "Person", id: "bob" },
      {},
    );
    await store.edges.knows.create(
      { kind: "Person", id: "alice" },
      { kind: "Person", id: "eve" },
      {},
    );

    const rows = await store
      .query()
      .from("Person", "p")
      .whereNode("p", (person) => person.id.eq("alice"))
      .optionalTraverse("knows", "e", { expand: "none" })
      .to("Person", "friend")
      .whereNode("friend", (friend) => friend.name.eq("Bob"))
      .groupByNode("p")
      .aggregate({
        name: field("p", "name"),
        matchingFollows: countEdges("e"),
      })
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.matchingFollows).toBe(1);
  });

  it("required traversal drops groups whose targets all fail a whereNode predicate", async () => {
    // Without countEdges: same predicate behavior. A required traversal
    // whose target predicate matches nothing should not produce a row
    // at all.
    await store.nodes.Person.create({ name: "Alice" }, { id: "alice" });
    await store.nodes.Person.create({ name: "Bob" }, { id: "bob" });
    await store.edges.knows.create(
      { kind: "Person", id: "alice" },
      { kind: "Person", id: "bob" },
      {},
    );

    const rows = await store
      .query()
      .from("Person", "p")
      .whereNode("p", (person) => person.id.eq("alice"))
      // Required (non-optional) traversal; no matching target.
      .traverse("knows", "e", { expand: "none" })
      .to("Person", "friend")
      .whereNode("friend", (friend) => friend.name.eq("Zoe"))
      .groupByNode("p")
      .aggregate({
        name: field("p", "name"),
        matchingFollows: countEdges("e"),
      })
      .execute();

    // Required traversal with no matching edges drops the start row
    // entirely — it must not produce a zero-count phantom row.
    expect(rows).toHaveLength(0);
  });

  it("paginated aggregate returns the right page with limit+offset", async () => {
    // Regression: when the fast path pushed LIMIT+OFFSET into the start
    // CTE, it also kept emitting LIMIT+OFFSET on the outer SELECT,
    // double-applying and yielding an empty page.
    for (let index = 0; index < 50; index += 1) {
      const id = `user_${String(index).padStart(3, "0")}`;
      await store.nodes.Person.create({ name: `User ${index}` }, { id });
    }
    // A single outgoing edge per user so every group has followCount=1.
    for (let index = 0; index < 50; index += 1) {
      const id = `user_${String(index).padStart(3, "0")}`;
      const targetId = `user_${String((index + 1) % 50).padStart(3, "0")}`;
      await store.edges.knows.create(
        { kind: "Person", id },
        { kind: "Person", id: targetId },
        {},
      );
    }

    const page1 = await store
      .query()
      .from("Person", "p")
      .optionalTraverse("knows", "e", { expand: "none" })
      .to("Person", "friend")
      .groupByNode("p")
      .aggregate({
        id: field("p", "id"),
        followCount: count("friend"),
      })
      .limit(10)
      .execute();

    const page2 = await store
      .query()
      .from("Person", "p")
      .optionalTraverse("knows", "e", { expand: "none" })
      .to("Person", "friend")
      .groupByNode("p")
      .aggregate({
        id: field("p", "id"),
        followCount: count("friend"),
      })
      .limit(10)
      .offset(10)
      .execute();

    expect(page1).toHaveLength(10);
    expect(page2).toHaveLength(10);
    // Pages must be disjoint — same row appearing in both means the
    // offset was ignored, and an empty page2 means the offset was
    // double-applied.
    const page1Ids = new Set(page1.map((row) => row.id));
    for (const row of page2) {
      expect(page1Ids.has(row.id as string)).toBe(false);
    }
  });
});
