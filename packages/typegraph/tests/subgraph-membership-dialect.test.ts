/**
 * Subgraph CTE membership emission.
 *
 * The subgraph extractor's final fetches filter node/edge ids against the
 * `included_ids` CTE. On SQLite this is inlined as `IN (subquery)` — evaluated
 * with a transient index and optimal as-is. On PostgreSQL the same
 * `IN (subquery)` form is pulled up into a join whose recursive-CTE row
 * estimate (~10 rows for a single-row seed) drives the planner into a
 * nested-loop join FILTER (measured at ~10M discarded rows / 383ms on the
 * depth-3 subgraph stress bench), so the PG path instead fetches the closure
 * ids once and passes them as a single `text[]` parameter, filtered via an
 * `unnest` semi-join (see `store/subgraph.ts`).
 *
 * This test pins SQLite's emitted membership form and that the subgraph fetches
 * actually route through it; cross-backend subgraph semantics — including the
 * PostgreSQL parameterized form — are covered by the shared integration suite.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineEdge, defineGraph, defineNode } from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { GraphBackend } from "../src/backend/types";

describe("subgraph fetches inline the SQLite CTE membership form", () => {
  const Person = defineNode("Person", {
    schema: z.object({ name: z.string() }),
  });
  const knows = defineEdge("knows");
  const graph = defineGraph({
    id: "subgraph-membership",
    nodes: { Person: { type: Person } },
    edges: { knows: { type: knows, from: [Person], to: [Person] } },
  });

  it("captures the membership form in both subgraph statements (SQLite)", async () => {
    const { backend: raw } = createLocalSqliteBackend();
    try {
      const captured: string[] = [];
      const backend: GraphBackend = {
        ...raw,
        async execute(query) {
          const compiled = raw.compileSql?.(query);
          if (compiled) captured.push(compiled.sql);
          return raw.execute(query);
        },
      };
      const store = createStore(graph, backend);

      const alice = await store.nodes.Person.create({ name: "alice" });
      const bob = await store.nodes.Person.create({ name: "bob" });
      await store.edges.knows.create(alice, bob);

      captured.length = 0;
      const result = await store.subgraph(alice.id, {
        edges: ["knows"],
        maxDepth: 2,
      });
      expect(result.root?.id).toBe(alice.id);

      const membershipStatements = captured.filter((text) =>
        text.includes("included_ids"),
      );
      expect(membershipStatements.length).toBeGreaterThanOrEqual(2);
      for (const text of membershipStatements) {
        expect(text).toContain("IN (SELECT id FROM included_ids)");
      }
    } finally {
      await raw.close();
    }
  });
});
