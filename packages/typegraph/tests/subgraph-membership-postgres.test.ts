/**
 * PostgreSQL subgraph membership: closure round trip and forced custom plan.
 *
 * store/subgraph.ts's PostgreSQL arm (the `"materialized-ids"`
 * `subgraphMembershipStrategy`) fetches the traversal closure's ids in one
 * extra round trip, then filters the node and edge fetches against that
 * materialized id array instead of inlining the recursive CTE the way
 * SQLite's `"inline-cte"` arm does (pinned in
 * `subgraph-membership-dialect.test.ts`) — see `store.subgraph()`'s
 * documented cost, "2 statements on SQLite and 3 on PostgreSQL", in
 * `store/store.ts`. Because the id array's length varies call to call, the
 * two filtered fetches are additionally marked to force PostgreSQL's generic
 * query plan (`markForceCustomPlan`) rather than caching one keyed to a
 * particular array size.
 *
 * Both facts are mechanism, not result correctness, so nothing in the
 * cross-backend integration suite would notice either regressing: this test
 * pins the round-trip count and the forced-plan intent directly, against a
 * real PostgreSQL dialect (PGlite, no Docker required).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineEdge, defineGraph, defineNode } from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import type { GraphBackend } from "../src/backend/types";
import { isSqlFragment, type SqlFragment } from "../src/query/sql-fragment";
import { shouldForceCustomPlan } from "../src/query/sql-intent";

describe("subgraph fetches route through PostgreSQL's materialized-ids membership form", () => {
  const Person = defineNode("Person", {
    schema: z.object({ name: z.string() }),
  });
  const knows = defineEdge("knows");
  const graph = defineGraph({
    id: "subgraph-membership-postgres",
    nodes: { Person: { type: Person } },
    edges: { knows: { type: knows, from: [Person], to: [Person] } },
  });

  it("costs exactly one closure round trip plus the two forced-plan fetches", async () => {
    const { backend: raw } = await createLocalPgliteBackend();
    try {
      const executed: SqlFragment[] = [];
      const backend: GraphBackend = deriveBackend(raw, {
        async execute(query) {
          if (isSqlFragment(query)) executed.push(query);
          return raw.execute(query);
        },
      });
      const store = createStore(graph, backend);

      const alice = await store.nodes.Person.create({ name: "alice" });
      const bob = await store.nodes.Person.create({ name: "bob" });
      await store.edges.knows.create(alice, bob);

      executed.length = 0;
      const result = await store.subgraph(alice.id, {
        edges: ["knows"],
        maxDepth: 2,
      });
      expect(result.root?.id).toBe(alice.id);

      expect(executed).toHaveLength(3);
      const forcedCustomPlanCount = executed.filter((query) =>
        shouldForceCustomPlan(query),
      ).length;
      expect(forcedCustomPlanCount).toBe(2);
    } finally {
      await raw.close();
    }
  });
});
