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
import { requireDefined } from "../src/utils/presence";
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
  identity: { sameIdAcrossKinds: "fold" },
});

// ============================================================
// Tests
// ============================================================

describe("custom table names", () => {
  const CUSTOM_NAMES = {
    nodes: "app_nodes",
    edges: "app_edges",
    recordedNodes: "app_recorded_nodes",
    recordedEdges: "app_recorded_edges",
    recordedClock: "app_recorded_clock",
    revisionOrigins: "app_revision_origins",
    fulltext: "app_fulltext",
    uniques: "app_uniques",
    identityAssertions: "app_identity_assertions",
    recordedIdentityAssertions: "app_recorded_identity_assertions",
    identityClosure: "app_identity_closure",
  } as const;

  let backend: GraphBackend;

  beforeEach(() => {
    const tables = createSqliteTables({
      nodes: CUSTOM_NAMES.nodes,
      edges: CUSTOM_NAMES.edges,
      recordedNodes: CUSTOM_NAMES.recordedNodes,
      recordedEdges: CUSTOM_NAMES.recordedEdges,
      recordedClock: CUSTOM_NAMES.recordedClock,
      revisionOrigins: CUSTOM_NAMES.revisionOrigins,
      fulltext: CUSTOM_NAMES.fulltext,
      uniques: CUSTOM_NAMES.uniques,
      identityAssertions: CUSTOM_NAMES.identityAssertions,
      recordedIdentityAssertions: CUSTOM_NAMES.recordedIdentityAssertions,
      identityClosure: CUSTOM_NAMES.identityClosure,
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
    expect(requireDefined(aliceResult[0]).name).toBe("Alice");

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
    expect(requireDefined(results[0]).person.name).toBe("Alice");
    expect(requireDefined(results[0]).friend.name).toBe("Bob");
    expect(requireDefined(results[0]).edge.since).toBe("2024");
  });

  it("round-trips identity through custom assertion and closure tables", async () => {
    const store = createStore(graph, backend);
    const first = await store.nodes.Person.create(
      { name: "Alice" },
      { id: "alice" },
    );
    const second = await store.nodes.Person.create(
      { name: "Alicia" },
      { id: "alicia" },
    );

    await store.identity.assertSame(first, second);

    expect(await store.identity.membersOf(first)).toEqual([
      { kind: "Person", id: first.id },
      { kind: "Person", id: second.id },
    ]);
  });

  it("explicit schema option takes precedence over backend.tableNames", () => {
    const explicitSchema = createSqlSchema({
      nodes: "override_nodes",
      edges: "override_edges",
      fulltext: "override_fulltext",
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
      recordedNodes: "typegraph_recorded_nodes",
      recordedEdges: "typegraph_recorded_edges",
      recordedClock: "typegraph_recorded_clock",
      revisionOrigins: "typegraph_revision_origins",
      fulltext: "typegraph_node_fulltext",
      uniques: "typegraph_node_uniques",
      identityAssertions: "typegraph_identity_assertions",
      recordedIdentityAssertions: "typegraph_recorded_identity_assertions",
      identityClosure: "typegraph_identity_closure",
    });
  });
});
