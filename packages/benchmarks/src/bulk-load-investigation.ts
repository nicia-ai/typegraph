import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import type Database from "better-sqlite3";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
  type TransactionBackend,
} from "@nicia-ai/typegraph";
import {
  FORMAT_VERSION,
  type GraphInterchangeChunk,
  importGraphStream,
  trustedImportGraphStream,
} from "@nicia-ai/typegraph/interchange";
import {
  createPostgresBackend,
  createPostgresTables,
  generatePostgresMigrationSQL,
} from "@nicia-ai/typegraph/adapters/drizzle/postgres";
import { createSqliteTables } from "@nicia-ai/typegraph/adapters/drizzle/sqlite";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";

import { startPostgresContainer } from "./real/harness/postgres-container";

const NODE_COUNT = Number.parseInt(
  process.env["BULK_NODE_COUNT"] ?? "100000",
  10,
);
const EDGE_COUNT = Number.parseInt(
  process.env["BULK_EDGE_COUNT"] ?? "300000",
  10,
);
const BATCH_SIZE = 20_000;
const USE_IN_MEMORY_SQLITE = process.env["BULK_STORAGE"] === "memory";
const BULK_DIALECT = process.env["BULK_DIALECT"] ?? "sqlite";

const Item = defineNode("Item", {
  schema: z.object({ content: z.string(), creationDate: z.string() }),
});
const relatedTo = defineEdge("relatedTo");
const graph = defineGraph({
  id: "bulk_investigation",
  nodes: { Item: { type: Item } },
  edges: {
    relatedTo: { type: relatedTo, from: [Item], to: [Item] },
  },
});

type IndexDefinition = Readonly<{ name: string; sql: string }>;
type ScenarioResult = Readonly<{
  finalizeMs: number;
  loadMs: number;
  name: string;
  totalMs: number;
}>;
type GraphStore = ReturnType<typeof createStore<typeof graph>>;
type BulkStoreSurface = Readonly<{
  edges: Readonly<{
    relatedTo: Pick<GraphStore["edges"]["relatedTo"], "bulkInsert">;
  }>;
  nodes: Readonly<{
    Item: Pick<GraphStore["nodes"]["Item"], "bulkInsert">;
  }>;
}>;

function reportScenarioResult(
  name: string,
  loadMs: number,
  finalizeMs: number,
): ScenarioResult {
  const totalMs = loadMs + finalizeMs;
  console.log(
    JSON.stringify({
      finalizeMs: Math.round(finalizeMs),
      loadMs: Math.round(loadMs),
      name,
      rowsPerSecond: Math.round(((NODE_COUNT + EDGE_COUNT) * 1000) / totalMs),
      totalMs: Math.round(totalMs),
    }),
  );
  return { finalizeMs, loadMs, name, totalMs };
}

function chunk<T>(values: readonly T[], size: number): readonly T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}

const nodeInputs = Array.from({ length: NODE_COUNT }, (_, index) => ({
  id: `node-${index}`,
  props: {
    content: `content-${index}`,
    creationDate: "2026-01-01T00:00:00.000Z",
  },
}));

const edgeInputs = Array.from({ length: EDGE_COUNT }, (_, index) => ({
  id: `edge-${index}`,
  from: { kind: "Item" as const, id: `node-${index % NODE_COUNT}` },
  to: {
    kind: "Item" as const,
    id: `node-${(index * 17 + 1) % NODE_COUNT}`,
  },
  props: {},
}));
const edgeInputsWithoutIds = edgeInputs.map(({ id: _id, ...item }) => item);

function secondaryIndexDefinitions(
  sqlite: Database.Database,
): readonly IndexDefinition[] {
  return sqlite
    .prepare(
      `SELECT name, sql
       FROM sqlite_master
       WHERE type = 'index'
         AND tbl_name IN ('typegraph_nodes', 'typegraph_edges')
         AND sql IS NOT NULL
       ORDER BY name`,
    )
    .all() as IndexDefinition[];
}

function dropSecondaryIndexes(
  sqlite: Database.Database,
  definitions: readonly IndexDefinition[],
): void {
  for (const definition of definitions) {
    sqlite.exec(`DROP INDEX "${definition.name.replaceAll('"', '""')}"`);
  }
}

function recreateSecondaryIndexes(
  sqlite: Database.Database,
  definitions: readonly IndexDefinition[],
): void {
  for (const definition of definitions) sqlite.exec(definition.sql);
}

function finalizeDatabase(sqlite: Database.Database): void {
  sqlite.exec("ANALYZE typegraph_nodes");
  sqlite.exec("ANALYZE typegraph_edges");
  sqlite.pragma("wal_checkpoint(TRUNCATE)");
}

async function insertWithStore(
  store: BulkStoreSurface,
  options: Readonly<{ generateEdgeIds?: boolean }> = {},
): Promise<void> {
  for (const batch of chunk(nodeInputs, BATCH_SIZE)) {
    await store.nodes.Item.bulkInsert(batch);
  }
  const edges = options.generateEdgeIds ? edgeInputsWithoutIds : edgeInputs;
  for (const batch of chunk(edges, BATCH_SIZE)) {
    await store.edges.relatedTo.bulkInsert(batch);
  }
}

function insertTrustedNative(sqlite: Database.Database): void {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const insertNode = sqlite.prepare(
    `INSERT INTO typegraph_nodes
       (graph_id, kind, id, props, version, valid_from, valid_to, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?)`,
  );
  const insertEdge = sqlite.prepare(
    `INSERT INTO typegraph_edges
       (graph_id, id, kind, from_kind, from_id, to_kind, to_id, props,
        valid_from, valid_to, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  );
  const insertAll = sqlite.transaction(() => {
    for (const item of nodeInputs) {
      insertNode.run(
        graph.id,
        Item.kind,
        item.id,
        JSON.stringify(item.props),
        timestamp,
        timestamp,
        timestamp,
      );
    }
    for (const item of edgeInputs) {
      insertEdge.run(
        graph.id,
        item.id,
        relatedTo.kind,
        item.from.kind,
        item.from.id,
        item.to.kind,
        item.to.id,
        JSON.stringify(item.props),
        timestamp,
        timestamp,
        timestamp,
      );
    }
  });
  insertAll();
}

async function insertTrustedBackend(backend: GraphBackend): Promise<void> {
  if (!("transaction" in backend)) {
    throw new Error("Trusted backend scenario requires transactions.");
  }
  await backend.transaction(async (transactionBackend: TransactionBackend) => {
    if (
      transactionBackend.insertNodesBatch === undefined ||
      transactionBackend.insertEdgesBatch === undefined
    ) {
      throw new Error("Trusted backend scenario requires batch inserts.");
    }
    for (const batch of chunk(nodeInputs, BATCH_SIZE)) {
      await transactionBackend.insertNodesBatch(
        batch.map((item) => ({
          graphId: graph.id,
          id: item.id,
          kind: Item.kind,
          props: item.props,
        })),
      );
    }
    for (const batch of chunk(edgeInputs, BATCH_SIZE)) {
      await transactionBackend.insertEdgesBatch(
        batch.map((item) => ({
          fromId: item.from.id,
          fromKind: item.from.kind,
          graphId: graph.id,
          id: item.id,
          kind: relatedTo.kind,
          props: item.props,
          toId: item.to.id,
          toKind: item.to.kind,
        })),
      );
    }
  });
}

async function* interchangeChunks(): AsyncGenerator<GraphInterchangeChunk> {
  yield {
    type: "header",
    header: {
      exportedAt: "2026-01-01T00:00:00.000Z",
      formatVersion: FORMAT_VERSION,
      source: { type: "external", description: "bulk investigation" },
    },
  };
  for (const batch of chunk(nodeInputs, BATCH_SIZE)) {
    yield {
      type: "nodes",
      nodes: batch.map((item) => ({
        id: item.id,
        kind: Item.kind,
        properties: item.props,
      })),
    };
  }
  for (const batch of chunk(edgeInputs, BATCH_SIZE)) {
    yield {
      type: "edges",
      edges: batch.map((item) => ({
        from: item.from,
        id: item.id,
        kind: relatedTo.kind,
        properties: item.props,
        to: item.to,
      })),
    };
  }
}

async function runScenario(
  name: string,
  options: Readonly<{
    deferIndexes: boolean;
    dropRedundantKindIndexes?: boolean;
    mode:
      | "store"
      | "store-generated-edge-ids"
      | "interchange-trusted-references"
      | "store-transaction"
      | "trusted-backend"
      | "trusted-native"
      | "trusted-public";
  }>,
): Promise<ScenarioResult> {
  const directory = mkdtempSync(
    join(tmpdir(), "typegraph-bulk-investigation-"),
  );
  const tables = createSqliteTables({});
  const { backend, db } = createLocalSqliteBackend({
    pragmas: { walAutocheckpointPages: 100_000 },
    tables,
    ...(USE_IN_MEMORY_SQLITE ? {} : { path: join(directory, "bench.db") }),
  });
  const sqlite = (db as unknown as { $client: Database.Database }).$client;
  const store = createStore(graph, backend, { autoRefreshStatistics: false });
  const indexes = secondaryIndexDefinitions(sqlite);
  if (options.deferIndexes) dropSecondaryIndexes(sqlite, indexes);
  if (options.dropRedundantKindIndexes) {
    dropSecondaryIndexes(
      sqlite,
      indexes.filter((index) => index.name.endsWith("_kind_idx")),
    );
  }

  try {
    const loadStart = performance.now();
    switch (options.mode) {
      case "store": {
        await insertWithStore(store);
        break;
      }
      case "store-generated-edge-ids": {
        await insertWithStore(store, { generateEdgeIds: true });
        break;
      }
      case "interchange-trusted-references": {
        const result = await importGraphStream(store, interchangeChunks(), {
          batchSize: BATCH_SIZE,
          onConflict: "error",
          onUnknownProperty: "error",
          refreshStatistics: false,
          validateReferences: false,
        });
        if (!result.success) {
          throw new Error(
            `Interchange import failed: ${result.errors[0]?.error}`,
          );
        }
        break;
      }
      case "store-transaction": {
        await store.transaction(async (transactionStore) => {
          await insertWithStore(transactionStore);
        });
        break;
      }
      case "trusted-native": {
        insertTrustedNative(sqlite);
        break;
      }
      case "trusted-public": {
        await trustedImportGraphStream(store, interchangeChunks());
        break;
      }
      case "trusted-backend": {
        await insertTrustedBackend(backend);
        break;
      }
    }
    const loadMs = performance.now() - loadStart;

    const finalizeStart = performance.now();
    if (options.deferIndexes) recreateSecondaryIndexes(sqlite, indexes);
    finalizeDatabase(sqlite);
    const finalizeMs = performance.now() - finalizeStart;
    return reportScenarioResult(name, loadMs, finalizeMs);
  } finally {
    await backend.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

async function runPostgresScenario(
  name: string,
  mode: "store" | "trusted-public",
): Promise<ScenarioResult> {
  const container = await startPostgresContainer();
  const pool = new Pool({ connectionString: container.connectionString });

  try {
    const tables = createPostgresTables({});
    await pool.query(generatePostgresMigrationSQL(tables));
    const backend = createPostgresBackend(drizzleNodePostgres(pool), {
      tables,
    });
    const store = createStore(graph, backend, {
      autoRefreshStatistics: false,
    });

    try {
      const loadStart = performance.now();
      if (mode === "trusted-public") {
        await trustedImportGraphStream(store, interchangeChunks());
      } else {
        await insertWithStore(store);
      }
      const loadMs = performance.now() - loadStart;

      const finalizeStart = performance.now();
      if (mode === "store") await store.refreshStatistics();
      const finalizeMs = performance.now() - finalizeStart;
      return reportScenarioResult(name, loadMs, finalizeMs);
    } finally {
      await backend.close();
    }
  } finally {
    await pool.end().catch(() => undefined);
    await container.close();
  }
}

console.log(
  `bulk-load investigation: ${NODE_COUNT.toLocaleString()} nodes + ${EDGE_COUNT.toLocaleString()} edges (${
    BULK_DIALECT === "postgres" ? "postgres"
    : USE_IN_MEMORY_SQLITE ? "memory"
    : "file"
  })`,
);

const scenarios = [
  {
    name: "store-live-indexes",
    options: {
      deferIndexes: false,
      mode: "store",
    } as const,
  },
  {
    name: "store-generated-edge-ids-live-indexes",
    options: {
      deferIndexes: false,
      mode: "store-generated-edge-ids",
    } as const,
  },
  {
    name: "store-without-redundant-kind-indexes",
    options: {
      deferIndexes: false,
      dropRedundantKindIndexes: true,
      mode: "store",
    } as const,
  },
  {
    name: "store-one-transaction-live-indexes",
    options: {
      deferIndexes: false,
      mode: "store-transaction",
    } as const,
  },
  {
    name: "interchange-trusted-references-live-indexes",
    options: {
      deferIndexes: false,
      mode: "interchange-trusted-references",
    } as const,
  },
  {
    name: "store-deferred-indexes",
    options: {
      deferIndexes: true,
      mode: "store",
    } as const,
  },
  {
    name: "trusted-public-atomic-deferred-indexes",
    options: {
      deferIndexes: false,
      mode: "trusted-public",
    } as const,
  },
  {
    name: "trusted-native-live-indexes",
    options: {
      deferIndexes: false,
      mode: "trusted-native",
    } as const,
  },
  {
    name: "trusted-backend-live-indexes",
    options: {
      deferIndexes: false,
      mode: "trusted-backend",
    } as const,
  },
  {
    name: "trusted-backend-deferred-indexes",
    options: {
      deferIndexes: true,
      mode: "trusted-backend",
    } as const,
  },
  {
    name: "trusted-native-deferred-indexes",
    options: {
      deferIndexes: true,
      mode: "trusted-native",
    } as const,
  },
] as const;

const requestedScenarios = new Set(
  (process.env["BULK_SCENARIOS"] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0),
);
const results: ScenarioResult[] = [];
if (BULK_DIALECT === "postgres") {
  const postgresScenarios = [
    { name: "store-live-indexes", mode: "store" },
    {
      name: "trusted-public-atomic-deferred-indexes",
      mode: "trusted-public",
    },
  ] as const;
  const selectedScenarios =
    requestedScenarios.size === 0 ?
      postgresScenarios
    : postgresScenarios.filter((scenario) =>
        requestedScenarios.has(scenario.name),
      );
  for (const scenario of selectedScenarios) {
    results.push(await runPostgresScenario(scenario.name, scenario.mode));
  }
} else {
  const selectedScenarios =
    requestedScenarios.size === 0 ?
      scenarios
    : scenarios.filter((scenario) => requestedScenarios.has(scenario.name));
  for (const scenario of selectedScenarios) {
    results.push(await runScenario(scenario.name, scenario.options));
  }
}

const baseline = results[0]?.totalMs;
if (baseline === undefined) {
  throw new Error("No matching bulk-load investigation scenarios selected.");
}
console.log("\nrelative to current store path:");
for (const result of results) {
  console.log(`${result.name}: ${(baseline / result.totalMs).toFixed(2)}x`);
}
