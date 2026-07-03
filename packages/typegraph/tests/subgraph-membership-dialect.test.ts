/**
 * Dialect-mediated CTE membership (`subqueryMembership`).
 *
 * The subgraph extractor's final fetches filter node/edge ids against the
 * `included_ids` CTE. On SQLite, `IN (subquery)` is evaluated with a
 * transient index and is optimal. On PostgreSQL, the same form is pulled
 * up into a join whose recursive-CTE row estimate (~10 rows for a
 * single-row seed) drives the planner into a nested-loop join FILTER —
 * measured at ~10M discarded rows / 383ms on the depth-3 subgraph stress
 * bench. `= ANY(ARRAY(subquery))` collapses the CTE once via InitPlan and
 * is hash-probed and index-condition eligible (~15ms for the same fetch).
 *
 * These tests pin each dialect's emitted form and that the subgraph
 * fetches actually route through it; cross-backend subgraph semantics are
 * covered by the shared integration suite.
 */
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineEdge, defineGraph, defineNode } from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { GraphBackend } from "../src/backend/types";
import { getDialect } from "../src/query/dialect";

describe("subqueryMembership dialect forms", () => {
  const column = sql.raw("e.to_id");
  const subquery = sql.raw("SELECT id FROM included_ids");

  it("emits IN (subquery) on SQLite", () => {
    const rendered = new SQLiteSyncDialect().sqlToQuery(
      getDialect("sqlite").subqueryMembership(column, subquery),
    );
    expect(rendered.sql).toBe("e.to_id IN (SELECT id FROM included_ids)");
  });

  it("emits = ANY(ARRAY(subquery)) on PostgreSQL", () => {
    const rendered = new PgDialect().sqlToQuery(
      getDialect("postgres").subqueryMembership(column, subquery),
    );
    expect(rendered.sql).toBe(
      "e.to_id = ANY(ARRAY(SELECT id FROM included_ids))",
    );
  });
});

describe("subgraph fetches route membership through the dialect", () => {
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
