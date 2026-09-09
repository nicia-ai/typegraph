/**
 * Tests for store.clear() API.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import {
  deriveBackend,
  projectBackendWithout,
} from "../src/backend/derive-backend";
import type {
  EngineRevision,
  GraphBackend,
  LineageMembers,
} from "../src/backend/types";
import {
  computeBaseVersion,
  engineAnchorOf,
  hasRevisionAnchor,
} from "../src/graph-merge/base-version";
import { createSqlSchema } from "../src/query/compiler/schema";
import { type CompiledRowsSql } from "../src/query/sql-intent";
import { createStore, createStoreWithSchema } from "../src/store";
import { mintsOriginNamespacedAnchor } from "../src/store/recorded-capture/lineage";
import { createTestBackend } from "./test-utils";

function dropTableSql(tableName: string): string {
  return `DROP TABLE "${tableName.replaceAll('"', '""')}"`;
}

function withSerializablePostgresProbe(base: GraphBackend): GraphBackend {
  return deriveBackend(base, {
    dialect: "postgres",
    async transaction(fn, options) {
      return base.transaction(
        (tx) =>
          fn({
            ...tx,
            dialect: "postgres",
            execute<T>(_query: CompiledRowsSql): Promise<readonly T[]> {
              return Promise.resolve([
                { transaction_isolation: "serializable" } as T,
              ]);
            },
          }),
        options,
      );
    },
  });
}

// ============================================================
// Test Schema
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({
    email: z.string(),
    name: z.string(),
  }),
});

const knows = defineEdge("knows", {
  schema: z.object({ since: z.string() }),
});

const graph = defineGraph({
  id: "store_clear_test",
  nodes: {
    Person: {
      type: Person,
      unique: [
        {
          name: "email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    knows: {
      type: knows,
      from: [Person],
      to: [Person],
    },
  },
  ontology: [],
});

// ============================================================
// store.clear() Tests
// ============================================================

describe("store.clear()", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  it("removes all nodes and edges for the graph", async () => {
    const store = createStore(graph, backend);
    const alice = await store.nodes.Person.create({
      email: "alice@example.com",
      name: "Alice",
    });
    const bob = await store.nodes.Person.create({
      email: "bob@example.com",
      name: "Bob",
    });
    await store.edges.knows.create(alice, bob, { since: "2020" });

    expect(await store.nodes.Person.count()).toBe(2);
    expect(await store.edges.knows.count()).toBe(1);

    await store.clear();

    expect(await store.nodes.Person.count()).toBe(0);
    expect(await store.edges.knows.count()).toBe(0);
  });

  it("removes uniqueness entries", async () => {
    const store = createStore(graph, backend);
    await store.nodes.Person.create({
      email: "alice@example.com",
      name: "Alice",
    });

    await store.clear();

    // After clear, the same unique key should be available
    const newAlice = await store.nodes.Person.create({
      email: "alice@example.com",
      name: "Alice 2",
    });
    expect(newAlice.name).toBe("Alice 2");
  });

  it("removes schema versions", async () => {
    const [store] = await createStoreWithSchema(graph, backend);
    const schemaBeforeClear = await backend.getActiveSchema(graph.id);
    expect(schemaBeforeClear).toBeDefined();

    await store.clear();

    const schemaAfterClear = await backend.getActiveSchema(graph.id);
    expect(schemaAfterClear).toBeUndefined();
  });

  it("store is usable after clear", async () => {
    const store = createStore(graph, backend);
    await store.nodes.Person.create({
      email: "alice@example.com",
      name: "Alice",
    });

    await store.clear();

    const newPerson = await store.nodes.Person.create({
      email: "bob@example.com",
      name: "Bob",
    });
    expect(newPerson.name).toBe("Bob");
    expect(await store.nodes.Person.count()).toBe(1);
  });

  it("resets schema metadata so an initialized store is usable after clear", async () => {
    const [store] = await createStoreWithSchema(graph, backend);
    await store.nodes.Person.create({
      email: "alice@example.com",
      name: "Alice",
    });

    await store.clear();

    expect(store.introspect().schemaVersion).toBeUndefined();
    await expect(
      store.nodes.Person.create({
        email: "bob@example.com",
        name: "Bob",
      }),
    ).resolves.toMatchObject({ name: "Bob" });
  });

  it("does not affect other graphs", async () => {
    const graph2 = defineGraph({
      id: "store_clear_test_other",
      nodes: {
        Person: { type: Person },
      },
      edges: {},
      ontology: [],
    });

    const store1 = createStore(graph, backend);
    const store2 = createStore(graph2, backend);

    await store1.nodes.Person.create({
      email: "alice@example.com",
      name: "Alice",
    });
    await store2.nodes.Person.create({
      email: "bob@example.com",
      name: "Bob",
    });

    await store1.clear();

    expect(await store1.nodes.Person.count()).toBe(0);
    expect(await store2.nodes.Person.count()).toBe(1);
  });

  it("clears an empty store without error", async () => {
    const store = createStore(graph, backend);
    await store.clear();
    expect(await store.nodes.Person.count()).toBe(0);
  });

  it("clears databases created before recorded history tables existed", async () => {
    const [initialized] = await createStoreWithSchema(graph, backend);
    await initialized.nodes.Person.create({
      email: "alice@example.com",
      name: "Alice",
    });

    const tableNames = backend.tableNames;
    if (tableNames === undefined || backend.executeDdl === undefined) {
      throw new Error("SQLite test backend should expose table names and DDL");
    }
    const schema = createSqlSchema(tableNames);
    await backend.executeDdl(dropTableSql(schema.tables.recordedEdges));
    await backend.executeDdl(dropTableSql(schema.tables.recordedNodes));
    await backend.executeDdl(dropTableSql(schema.tables.recordedClock));

    const runtimeStore = createStore(graph, backend);
    await expect(runtimeStore.clear()).resolves.toBeUndefined();
    expect(await runtimeStore.nodes.Person.count()).toBe(0);
    expect(await backend.getActiveSchema(graph.id)).toBeUndefined();
  });

  it("bypasses recorded-capture transaction guards under history", async () => {
    const historyStore = createStore(
      graph,
      withSerializablePostgresProbe(backend),
      { history: true },
    );

    await expect(historyStore.clear()).resolves.toBeUndefined();
  });
});

describe("store.clear() rotates the durable revision origin", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  it("mints a different revisionOriginNow() after clear(), under history", async () => {
    const store = createStore(graph, backend, { history: true });
    await store.nodes.Person.create({
      email: "alice@example.com",
      name: "Alice",
    });
    const originBeforeClear = await store.revisionOriginNow();

    await store.clear();

    const originAfterClear = await store.revisionOriginNow();
    // Mutation-proof: commenting out `clear()`'s `resetRevisionOrigin` call
    // (`store.ts`) makes this equality hold instead — a pre-clear branch's
    // revision anchor would silently match
    // again once the graph is repopulated to the same revision count.
    expect(originAfterClear).not.toBe(originBeforeClear);
  });

  it("mints a different revisionOriginNow() after clear(), under plain revisionTracking (no history)", async () => {
    const store = createStore(graph, backend, { revisionTracking: true });
    await store.nodes.Person.create({
      email: "alice@example.com",
      name: "Alice",
    });
    const originBeforeClear = await store.revisionOriginNow();

    await store.clear();

    const originAfterClear = await store.revisionOriginNow();
    expect(originAfterClear).not.toBe(originBeforeClear);
  });

  it("rotates the origin even when revisionOriginNow() was never called before the first clear()", async () => {
    // Proves rotation does not depend on a prior `revisionOriginNow()` call
    // having minted the row. It does NOT exercise `ensureRevisionOriginsRelation`'s
    // own lazy-bootstrap path on this fixture: `createTestBackend()`'s local
    // SQLite backend installs the FULL base schema — `typegraph_revision_origins`
    // included — at construction time (`installLocalSqliteBaseSchema`,
    // `src/backend/sqlite/local.ts`), so the table already exists before
    // `clear()` ever runs here, the same as it does on the bundled PGlite and
    // server-Postgres factories. `clear()`'s upfront `ensureRevisionOriginsRelation`
    // call is a proven no-op on every bundled backend for this reason; it exists
    // only for a custom backend whose `ensureRevisionOriginsTable` provisions
    // the relation lazily instead.
    const store = createStore(graph, backend, { history: true });
    await store.nodes.Person.create({
      email: "alice@example.com",
      name: "Alice",
    });

    await expect(store.clear()).resolves.toBeUndefined();
    await expect(store.revisionOriginNow()).resolves.toEqual(
      expect.any(String),
    );
  });
});

function scriptedLineage(): LineageMembers {
  return {
    revision: () => Promise.resolve("r1" as EngineRevision),
    changesSince: () => Promise.resolve({ kind: "unbounded" as const }),
  };
}

describe("store.clear() and the anchor-origin predicate", () => {
  it("mintsOriginNamespacedAnchor agrees with the form of the token computeBaseVersion mints", async () => {
    const tracked = createStore(graph, createTestBackend(), {
      revisionTracking: true,
    });
    const engineAnchored = createStore(
      graph,
      deriveBackend(createTestBackend(), { lineage: scriptedLineage() }),
    );
    const fingerprinted = createStore(graph, createTestBackend());
    for (const store of [tracked, engineAnchored, fingerprinted]) {
      const token = await computeBaseVersion(store);
      const originNamespaced =
        hasRevisionAnchor(token) || engineAnchorOf(token) !== undefined;
      expect(mintsOriginNamespacedAnchor(store, true)).toBe(originNamespaced);
    }
    expect(mintsOriginNamespacedAnchor(fingerprinted, true)).toBe(false);
  });

  it("clears a store whose backend declares lineage but cannot bootstrap revision origins", async () => {
    // Such a store mints no engine anchor at all (computeBaseVersion refuses
    // it), so there is no origin to rotate and clear() must not refuse
    // either — it did once the rotation was gated on lineage alone.
    const backend = projectBackendWithout(
      deriveBackend(createTestBackend(), { lineage: scriptedLineage() }),
      ["ensureRevisionOriginsTable"],
    ) as unknown as GraphBackend;
    const store = createStore(graph, backend);
    await store.nodes.Person.create({
      email: "alice@example.com",
      name: "Alice",
    });

    await expect(store.clear()).resolves.toBeUndefined();
    const remaining = await store.nodes.Person.find();
    expect(remaining).toHaveLength(0);
  });
});
