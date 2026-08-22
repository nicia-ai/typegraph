/**
 * Schema-fenced insert round trips (#533).
 *
 * A qualifying write owns exactly one relevant SQL operation: its INSERT also
 * locks and validates the active schema row. Member-level counters pin the
 * portable backend contract; driver-level SQLite and PostgreSQL observations
 * below prove the engine actually receives that one fused SQL statement.
 */
import { PGlite } from "@electric-sql/pglite";
import type Database from "better-sqlite3";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineGraphExtension,
  defineNode,
} from "../src";
import {
  deriveBackend,
  projectBackendWithout,
} from "../src/backend/derive-backend";
import { generatePostgresDDL } from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/postgres";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type {
  AdapterBackend,
  GraphBackend,
  TransactionBackend,
} from "../src/backend/types";
import { requireDefined } from "../src/utils/presence";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const knows = defineEdge("knows", { schema: z.object({}) });

function graph(id: string) {
  return defineGraph({
    id,
    nodes: { Person: { type: Person } },
    edges: { knows: { type: knows, from: [Person], to: [Person] } },
  });
}

interface FusedCounts {
  fence: number;
  node: number;
  edge: number;
}

type RecordedSqlBackend = Readonly<{
  backend: GraphBackend;
  close: () => Promise<void>;
  reset: () => void;
  statements: readonly string[];
}>;

function schemaWriteStatements(
  statements: readonly string[],
  table: "typegraph_nodes" | "typegraph_edges",
): readonly string[] {
  return statements.filter((statement) =>
    statement.toLowerCase().includes(`insert into "${table}"`),
  );
}

function expectFusedWriteExecution(
  statements: readonly string[],
  table: "typegraph_nodes" | "typegraph_edges",
): void {
  const writes = schemaWriteStatements(statements, table);
  expect(writes).toHaveLength(1);
  expect(writes[0]?.toLowerCase()).toContain("typegraph_schema_versions");
  expect(
    statements.filter((statement) =>
      statement.toLowerCase().includes("typegraph_schema_versions"),
    ),
  ).toHaveLength(1);
}

async function createRecordedPgliteBackend(): Promise<RecordedSqlBackend> {
  const client = await PGlite.create();
  await client.exec(generatePostgresDDL().join("\n\n"));
  const statements: string[] = [];
  const backend = createPostgresBackend(
    drizzlePglite(client, {
      logger: {
        logQuery(query: string): void {
          statements.push(query);
        },
      },
    }),
    { vector: false },
  );

  return {
    backend,
    close: () => client.close(),
    reset: () => {
      statements.splice(0);
    },
    statements,
  };
}

function countFusedStatements(backend: GraphBackend): {
  backend: GraphBackend;
  counts: FusedCounts;
} {
  const counts: FusedCounts = { edge: 0, fence: 0, node: 0 };

  function wrap(target: TransactionBackend): TransactionBackend {
    return deriveBackend(target, {
      async lockSchemaVersionForWrite(params) {
        counts.fence += 1;
        await requireDefined(target.lockSchemaVersionForWrite)(params);
      },
      async insertNodeWithSchemaFence(params, fence) {
        counts.node += 1;
        return requireDefined(target.insertNodeWithSchemaFence)(params, fence);
      },
      async insertNodeIfAbsentWithSchemaFence(params, fence) {
        counts.node += 1;
        return requireDefined(target.insertNodeIfAbsentWithSchemaFence)(
          params,
          fence,
        );
      },
      async insertEdgeIfEndpointsLiveWithSchemaFence(params, fence) {
        counts.edge += 1;
        return requireDefined(target.insertEdgeIfEndpointsLiveWithSchemaFence)(
          params,
          fence,
        );
      },
      async insertNode(params) {
        counts.node += 1;
        return target.insertNode(params);
      },
      async insertNodeIfAbsent(params) {
        counts.node += 1;
        return requireDefined(target.insertNodeIfAbsent)(params);
      },
      async insertEdgeIfEndpointsLive(params) {
        counts.edge += 1;
        return requireDefined(target.insertEdgeIfEndpointsLive)(params);
      },
    });
  }

  return {
    backend: deriveBackend(backend, {
      transaction: (fn, options) =>
        backend.transaction((tx) => fn(wrap(tx)), options),
    }),
    counts,
  };
}

function countAdoptedFallbackStatements<TNative>(
  backend: AdapterBackend<TNative>,
): { backend: AdapterBackend<TNative>; counts: FusedCounts } {
  const counts: FusedCounts = { edge: 0, fence: 0, node: 0 };

  function wrap(target: TransactionBackend): TransactionBackend {
    return deriveBackend(target, {
      async lockSchemaVersionForWrite(params) {
        counts.fence += 1;
        await requireDefined(target.lockSchemaVersionForWrite)(params);
      },
      async insertNode(params) {
        counts.node += 1;
        return target.insertNode(params);
      },
    });
  }

  return {
    backend: deriveBackend(backend, {
      transaction: (fn, options) =>
        backend.transaction((tx) => fn(wrap(tx)), options),
      adoptTransaction: (externalTransaction) =>
        wrap(backend.adoptTransaction(externalTransaction)),
    }),
    counts,
  };
}

function countUnmarkedTransactionFallback(backend: GraphBackend): {
  backend: GraphBackend;
  counts: FusedCounts;
} {
  const counts: FusedCounts = { edge: 0, fence: 0, node: 0 };

  function wrap(target: TransactionBackend): TransactionBackend {
    // A caller-owned proxy has distinct object identity, so it deliberately
    // lacks the factory's out-of-band origin evidence while preserving the
    // underlying transaction resource. The Store must retain its ordinary
    // verified write path for this custom wrapper.
    const unmarkedTarget: TransactionBackend = new Proxy(target, {});
    return deriveBackend(unmarkedTarget, {
      async lockSchemaVersionForWrite(params) {
        counts.fence += 1;
        await requireDefined(unmarkedTarget.lockSchemaVersionForWrite)(params);
      },
      async insertNode(params) {
        counts.node += 1;
        return unmarkedTarget.insertNode(params);
      },
      async insertEdgeIfEndpointsLive(params) {
        counts.edge += 1;
        return requireDefined(unmarkedTarget.insertEdgeIfEndpointsLive)(params);
      },
    });
  }

  return {
    backend: deriveBackend(backend, {
      transaction: (fn, options) =>
        backend.transaction((target) => fn(wrap(target)), options),
    }),
    counts,
  };
}

async function assertFusedInsertBudget(
  backend: GraphBackend,
  graphId: string,
): Promise<void> {
  const observed = countFusedStatements(backend);
  const [store] = await createStoreWithSchema(graph(graphId), observed.backend);

  await store.nodes.Person.create({ name: "Alice" });
  expect(observed.counts).toEqual({ edge: 0, fence: 0, node: 1 });

  observed.counts.edge = 0;
  observed.counts.fence = 0;
  observed.counts.node = 0;
  await store.nodes.Person.create({ name: "Supplied" }, { id: "supplied" });
  expect(observed.counts).toEqual({ edge: 0, fence: 0, node: 1 });

  const alice = await store.nodes.Person.create({ name: "Alice" });
  const bob = await store.nodes.Person.create({ name: "Bob" });
  observed.counts.edge = 0;
  observed.counts.fence = 0;
  observed.counts.node = 0;

  await store.edges.knows.create(alice, bob, {});
  expect(observed.counts).toEqual({ edge: 1, fence: 0, node: 0 });
}

async function statementCountForGeneratedNodeCreate(
  backend: GraphBackend,
  graphId: string,
  useFusedInsert: boolean,
): Promise<number> {
  const portableBackend =
    useFusedInsert ? backend : (
      projectBackendWithout(backend, [
        "insertEdgeIfEndpointsLiveWithSchemaFence",
        "insertNodeIfAbsentWithSchemaFence",
        "insertNodeWithSchemaFence",
      ])
    );
  const observed = countFusedStatements(portableBackend);
  const [store] = await createStoreWithSchema(graph(graphId), observed.backend);
  await store.nodes.Person.create({ name: "Alice" });
  return observed.counts.fence + observed.counts.node + observed.counts.edge;
}

async function assertUnmarkedTransactionFallback(
  backend: GraphBackend,
  graphId: string,
): Promise<void> {
  const observed = countUnmarkedTransactionFallback(backend);
  const [store] = await createStoreWithSchema(graph(graphId), observed.backend);

  const alice = await store.nodes.Person.create({ name: "Alice" });
  expect(observed.counts).toEqual({ edge: 0, fence: 1, node: 1 });

  const bob = await store.nodes.Person.create({ name: "Bob" });
  observed.counts.edge = 0;
  observed.counts.fence = 0;
  observed.counts.node = 0;
  await store.edges.knows.create(alice, bob, {});
  expect(observed.counts).toEqual({ edge: 1, fence: 1, node: 0 });
}

async function assertZeroRowContinuation(
  backend: GraphBackend,
  graphId: string,
): Promise<void> {
  const [store] = await createStoreWithSchema(graph(graphId), backend);
  const source = await store.nodes.Person.create(
    { name: "Source" },
    { id: "source" },
  );
  await store.nodes.Person.create({ name: "Original" }, { id: "duplicate" });

  await expect(
    store.nodes.Person.create({ name: "Duplicate" }, { id: "duplicate" }),
  ).rejects.toMatchObject({
    details: { entityType: "node", id: "duplicate", operation: "create" },
  });

  await expect(
    store.edges.knows.create(source, { kind: "Person", id: "missing" }, {}),
  ).rejects.toMatchObject({
    details: { endpoint: "to", nodeId: "missing" },
  });

  const ended = await store.nodes.Person.create(
    { name: "Ended" },
    { id: "ended" },
  );
  await store.nodes.Person.delete(ended.id);
  await expect(
    store.edges.knows.create(source, ended, {}),
  ).rejects.toMatchObject({ details: { endpoint: "to", nodeId: "ended" } });
}

describe("schema-fenced insert budget", () => {
  it("executes one schema-fenced SQLite INSERT for successful nodes and many edges", async () => {
    const { backend, db } = createLocalSqliteBackend();
    const statements: string[] = [];
    // The public local-factory result widens Drizzle's return type and omits
    // its documented `$client`; recover that driver-only test seam here.
    const sqlite = (db as typeof db & { $client: Database.Database }).$client;
    const prepare = sqlite.prepare.bind(sqlite);
    const prepareSpy = vi
      .spyOn(sqlite, "prepare")
      .mockImplementation((query) => {
        statements.push(query);
        return prepare(query);
      });
    try {
      const [store] = await createStoreWithSchema(
        graph("schema_fused_sqlite_driver"),
        backend,
      );

      statements.splice(0);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      expectFusedWriteExecution(statements, "typegraph_nodes");

      const bob = await store.nodes.Person.create({ name: "Bob" });
      statements.splice(0);
      await store.edges.knows.create(alice, bob, {});
      expectFusedWriteExecution(statements, "typegraph_edges");
    } finally {
      prepareSpy.mockRestore();
      await backend.close();
    }
  });

  it("executes one schema-fenced PostgreSQL INSERT for successful nodes and many edges", async () => {
    const recorded = await createRecordedPgliteBackend();
    try {
      const [store] = await createStoreWithSchema(
        graph("schema_fused_postgres_driver"),
        recorded.backend,
      );

      recorded.reset();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      expectFusedWriteExecution(recorded.statements, "typegraph_nodes");

      const bob = await store.nodes.Person.create({ name: "Bob" });
      recorded.reset();
      await store.edges.knows.create(alice, bob, {});
      expectFusedWriteExecution(recorded.statements, "typegraph_edges");
    } finally {
      await recorded.close();
    }
  });

  it("SQLite folds the successful node and many-edge schema fence into one statement", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      await assertFusedInsertBudget(backend, "schema_fused_sqlite");
    } finally {
      await backend.close();
    }
  });

  it("PostgreSQL folds the successful node and many-edge schema fence into one statement", async () => {
    const { backend } = await createLocalPgliteBackend({ vector: false });
    try {
      await assertFusedInsertBudget(backend, "schema_fused_postgres");
    } finally {
      await backend.close();
    }
  });

  it("saves exactly one statement against the portable schema-fence fallback", async () => {
    const fused = createLocalSqliteBackend();
    const fallback = createLocalSqliteBackend();
    try {
      const fusedStatements = await statementCountForGeneratedNodeCreate(
        fused.backend,
        "schema_fused_budget_enabled",
        true,
      );
      const fallbackStatements = await statementCountForGeneratedNodeCreate(
        fallback.backend,
        "schema_fused_budget_disabled",
        false,
      );
      expect(fallbackStatements).toBe(fusedStatements + 1);
    } finally {
      await fused.backend.close();
      await fallback.backend.close();
    }
  });

  it("falls back to the ordinary fence inside a caller-adopted SQLite transaction", async () => {
    const { backend, db } = createLocalSqliteBackend();
    const observed = countAdoptedFallbackStatements(backend);
    try {
      const [store] = await createAdapterStoreWithSchema(
        graph("schema_fused_adopted"),
        observed.backend,
      );
      const txStore = store.withTransaction(db);
      await txStore.nodes.Person.create({ name: "Alice" });
      expect(observed.counts).toEqual({ edge: 0, fence: 1, node: 1 });
    } finally {
      await backend.close();
    }
  });

  it("falls back to the ordinary node and matching-edge paths when a SQLite transaction wrapper is unmarked", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      await assertUnmarkedTransactionFallback(
        backend,
        "schema_fused_unmarked_sqlite",
      );
    } finally {
      await backend.close();
    }
  });

  it("falls back to the ordinary node and matching-edge paths when a PostgreSQL transaction wrapper is unmarked", async () => {
    const { backend } = await createLocalPgliteBackend({ vector: false });
    try {
      await assertUnmarkedTransactionFallback(
        backend,
        "schema_fused_unmarked_postgres",
      );
    } finally {
      await backend.close();
    }
  });

  it("diagnoses a zero-row fused SQLite insert with the settled active version", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [stale] = await createStoreWithSchema(
        graph("schema_fused_stale"),
        backend,
      );
      await stale.evolve(
        defineGraphExtension({
          nodes: {
            Extra: { properties: { label: { type: "string" } } },
          },
        }),
      );

      await expect(
        stale.nodes.Person.create({ name: "late" }),
      ).rejects.toMatchObject({
        details: { actual: 2, expected: 1 },
      });
    } finally {
      await backend.close();
    }
  });

  it("diagnoses a zero-row fused PostgreSQL insert with the settled active version", async () => {
    const { backend } = await createLocalPgliteBackend({ vector: false });
    try {
      const [stale] = await createStoreWithSchema(
        graph("schema_fused_stale_postgres"),
        backend,
      );
      await stale.evolve(
        defineGraphExtension({
          nodes: {
            Extra: { properties: { label: { type: "string" } } },
          },
        }),
      );

      await expect(
        stale.nodes.Person.create({ name: "late" }),
      ).rejects.toMatchObject({
        details: { actual: 2, expected: 1 },
      });
    } finally {
      await backend.close();
    }
  });

  it("continues a schema-current SQLite zero-row result to its duplicate and endpoint diagnostics", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      await assertZeroRowContinuation(backend, "schema_fused_continue_sqlite");
    } finally {
      await backend.close();
    }
  });

  it("continues a schema-current PostgreSQL zero-row result to its duplicate and endpoint diagnostics", async () => {
    const { backend } = await createLocalPgliteBackend({ vector: false });
    try {
      await assertZeroRowContinuation(
        backend,
        "schema_fused_continue_postgres",
      );
    } finally {
      await backend.close();
    }
  });
});
