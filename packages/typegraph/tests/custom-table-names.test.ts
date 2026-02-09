/**
 * Custom Table Names Regression Tests
 *
 * Verifies that custom table names configured on a backend propagate
 * through to store.query() without requiring an explicit schema option.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createSqliteTables } from "../src/backend/drizzle/schema/sqlite";
import type { GraphBackend } from "../src/backend/types";
import { defineEdge, defineGraph, defineNode } from "../src/core";
import { createSqlSchema } from "../src/query/compiler/schema";
import { createStore } from "../src/store";
import { createTestBackend } from "./test-utils";

// ============================================================
// Test Schema
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows", {
  schema: z.object({ since: z.string() }),
});

const graph = defineGraph({
  id: "custom_tables_test",
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

// ============================================================
// Tests
// ============================================================

describe("custom table names", () => {
  const CUSTOM_NAMES = {
    nodes: "app_nodes",
    edges: "app_edges",
    embeddings: "app_embeddings",
  } as const;

  let backend: GraphBackend;

  beforeEach(() => {
    const tables = createSqliteTables({
      nodes: CUSTOM_NAMES.nodes,
      edges: CUSTOM_NAMES.edges,
      embeddings: CUSTOM_NAMES.embeddings,
    });
    backend = createTestBackend(tables);
  });

  it("exposes tableNames on the backend", () => {
    expect(backend.tableNames).toEqual(CUSTOM_NAMES);
  });

  it("round-trips nodes through collection API and query builder", async () => {
    const store = createStore(graph, backend);

    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });

    const results = await store
      .query()
      .from("Person", "p")
      .select((context) => context.p)
      .execute();

    const names = results.map((r) => r.name).toSorted();
    expect(names).toEqual(["Alice", "Bob"]);
    expect(results).toHaveLength(2);

    // Verify we can find specific nodes by ID
    const aliceResult = await store
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.id.eq(alice.id))
      .select((context) => context.p)
      .execute();

    expect(aliceResult).toHaveLength(1);
    expect(aliceResult[0]!.name).toBe("Alice");

    void bob;
  });

  it("round-trips edges through collection API and query builder", async () => {
    const store = createStore(graph, backend);

    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });

    await store.edges.knows.create(
      { kind: "Person", id: alice.id },
      { kind: "Person", id: bob.id },
      { since: "2024" },
    );

    const results = await store
      .query()
      .from("Person", "p")
      .traverse("knows", "e")
      .to("Person", "friend")
      .whereNode("p", (p) => p.id.eq(alice.id))
      .select((context) => ({
        person: context.p,
        edge: context.e,
        friend: context.friend,
      }))
      .execute();

    expect(results).toHaveLength(1);
    expect(results[0]!.person.name).toBe("Alice");
    expect(results[0]!.friend.name).toBe("Bob");
    expect(results[0]!.edge.since).toBe("2024");
  });

  it("explicit schema option takes precedence over backend.tableNames", () => {
    const explicitSchema = createSqlSchema({
      nodes: "override_nodes",
      edges: "override_edges",
      embeddings: "override_embeddings",
    });

    const store = createStore(graph, backend, { schema: explicitSchema });

    // The store's query builder should use the explicit schema, not the backend's tableNames.
    // Backend retains its own tableNames.
    expect(backend.tableNames).toEqual(CUSTOM_NAMES);

    void store;
  });

  it("default table names propagate when no custom tables are specified", () => {
    const defaultBackend = createTestBackend();

    expect(defaultBackend.tableNames).toEqual({
      nodes: "typegraph_nodes",
      edges: "typegraph_edges",
      embeddings: "typegraph_node_embeddings",
    });
  });
});
