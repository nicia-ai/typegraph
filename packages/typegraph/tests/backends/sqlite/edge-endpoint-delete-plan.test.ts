/**
 * The write-path statements that find a node's edges at either endpoint seek
 * `typegraph_edges_from_idx` and `typegraph_edges_to_idx` under every
 * statistics state SQLite can be in, instead of walking every edge in the
 * graph.
 *
 * The statements are the edge hard delete for a node
 * (`buildHardDeleteEdgesByNode`, run by `hardDelete`), the live-edge probe
 * inside the atomic node-delete batch
 * (`buildAtomicNodeDeleteBatchWithSchemaFence`), and history capture's
 * selection of the edges that hard delete removes (`queryConnectedEdgeIds`).
 * All three match `(from side) OR (to side)`. With the graph equality written once, outside the OR, SQLite
 * with no `sqlite_stat1` planned `typegraph_edges_to_idx (graph_id=?)`: a walk
 * of the graph's edges for every deleted node. The three states covered are a
 * database that was never analyzed, the sampled statistics
 * `refreshStatistics()` collects, and STAT1-only statistics (a full ANALYZE on
 * a build without STAT4).
 *
 * Revert check: restoring the shared `graph_id = ?` conjunct in
 * `edgeAtEitherEndpoint` fails the first two cases in the never-analyzed
 * state, and restoring it in `queryConnectedEdgeIds` fails the third.
 */
import type Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type Store,
} from "../../../src";
import { buildHardDeleteEdgesByNode } from "../../../src/backend/drizzle/operations/edges";
import { buildAtomicNodeDeleteBatchWithSchemaFence } from "../../../src/backend/drizzle/operations/nodes";
import { createSqliteTables } from "../../../src/backend/sqlite";
import {
  createLocalSqliteBackend,
  type LocalSqliteBackendResult,
} from "../../../src/backend/sqlite/local";
import { type TransactionBackend } from "../../../src/backend/types";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import {
  renderSqlite,
  type SqlFragment,
} from "../../../src/query/sql-fragment";
import { legacyTransactionOperation } from "../../../src/store/operation-scope";
import { queryConnectedEdgeIds } from "../../../src/store/recorded-capture/flush";
import { requireDefined } from "../../../src/utils/presence";

const Item = defineNode("Item", { schema: z.object({ name: z.string() }) });
const links = defineEdge("links");

const graph = defineGraph({
  id: "edge_endpoint_delete_plan",
  nodes: { Item: { type: Item } },
  edges: { links: { type: links, from: [Item], to: [Item] } },
});

const NODES = 2000;
const EDGES = 4000;

/** Rows shaped as the library writes them; every 50th edge is a self-loop. */
const SEED_SQL = `
WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ${NODES})
INSERT INTO typegraph_nodes (graph_id, kind, id, props, version, valid_from, created_at, updated_at)
SELECT 'edge_endpoint_delete_plan', 'Item', 'n' || i, json_object('name', 'n' || i), 1,
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z' FROM s;
WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ${EDGES})
INSERT INTO typegraph_edges (graph_id, id, kind, from_kind, from_id, to_kind, to_id, props, valid_from, created_at, updated_at)
SELECT 'edge_endpoint_delete_plan', 'e' || i, 'links', 'Item', 'n' || (1 + i % ${NODES}), 'Item',
       'n' || CASE WHEN i % 50 = 0 THEN 1 + i % ${NODES} ELSE 1 + (i * 7919) % ${NODES} END,
       '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z' FROM s;
`;

type StatisticsState = "never analyzed" | "refreshStatistics()" | "STAT1 only";

/**
 * Puts the connection's planner into one statistics state. Dropping or
 * rewriting the stat tables changes the schema, which makes SQLite reload
 * statistics before the next plan.
 */
async function enterState(
  state: StatisticsState,
  client: Database.Database,
  store: Store<typeof graph>,
): Promise<void> {
  client.exec(
    "DROP TABLE IF EXISTS sqlite_stat1; DROP TABLE IF EXISTS sqlite_stat4;",
  );
  switch (state) {
    case "never analyzed": {
      return;
    }
    case "refreshStatistics()": {
      await store.refreshStatistics();
      return;
    }
    case "STAT1 only": {
      client.exec(
        "PRAGMA analysis_limit = 0; ANALYZE typegraph_nodes; ANALYZE typegraph_edges; DELETE FROM sqlite_stat4; ANALYZE sqlite_schema;",
      );
      return;
    }
  }
}

const STATES: readonly StatisticsState[] = [
  "never analyzed",
  "refreshStatistics()",
  "STAT1 only",
];

const FROM_SEEK =
  "typegraph_edges_from_idx (graph_id=? AND from_kind=? AND from_id=?)";
const TO_SEEK = "typegraph_edges_to_idx (graph_id=? AND to_kind=? AND to_id=?)";
const GRAPH_WIDE_EDGE_ACCESS =
  /SCAN typegraph_edges|typegraph_edges USING (?:COVERING )?INDEX \S+ \(graph_id=\?\)/u;

function expectEndpointSeeks(detail: string): void {
  expect(detail).toContain(FROM_SEEK);
  expect(detail).toContain(TO_SEEK);
  expect(detail).not.toMatch(GRAPH_WIDE_EDGE_ACCESS);
}

describe("edge lookups by endpoint on the SQLite delete path", () => {
  let local: LocalSqliteBackendResult;
  let client: Database.Database;
  let store: Store<typeof graph>;
  const tables = createSqliteTables();

  beforeEach(async () => {
    local = createLocalSqliteBackend();
    client = (local.db as unknown as { $client: Database.Database }).$client;
    [store] = await createStoreWithSchema(graph, local.backend);
    client.exec(SEED_SQL);
  });

  afterEach(async () => {
    await local.backend.close();
  });

  function plan(statement: ReturnType<typeof sql>): string {
    const rows = local.db.all<{ detail: string }>(
      sql`EXPLAIN QUERY PLAN ${statement}`,
    );
    return rows.map((row) => row.detail).join("\n");
  }

  it.each(STATES)(
    "hard delete of a node's edges seeks both endpoint indexes (%s)",
    async (state) => {
      await enterState(state, client, store);
      expectEndpointSeeks(
        plan(
          buildHardDeleteEdgesByNode(
            tables,
            "edge_endpoint_delete_plan",
            "Item",
            "n7",
          ),
        ),
      );
    },
  );

  it.each(STATES)(
    "history capture's selection of a hard-deleted node's edges seeks both endpoint indexes (%s)",
    async (state) => {
      await enterState(state, client, store);
      let captured: SqlFragment | undefined;
      const recordingTarget = {
        execute: (query: SqlFragment) => {
          captured = query;
          return Promise.resolve([]);
        },
      } as unknown as TransactionBackend;
      await queryConnectedEdgeIds(
        legacyTransactionOperation(recordingTarget),
        createSqlSchema(),
        {
          graphId: "edge_endpoint_delete_plan",
          kind: "Item",
          id: "n7",
        },
      );
      // Bound parameters, as the driver executes it: inlined as literals,
      // the two arms' identical graph equalities would be one expression.
      const rendered = renderSqlite(requireDefined(captured));
      const rows = client
        .prepare(`EXPLAIN QUERY PLAN ${rendered.sql}`)
        .all(...rendered.params) as readonly Readonly<{ detail: string }>[];
      expectEndpointSeeks(rows.map((row) => row.detail).join("\n"));
    },
  );

  it.each(STATES)(
    "the atomic node-delete batch's live-edge probe seeks both endpoint indexes (%s)",
    async (state) => {
      await enterState(state, client, store);
      expectEndpointSeeks(
        plan(
          buildAtomicNodeDeleteBatchWithSchemaFence(
            tables,
            {
              graphId: "edge_endpoint_delete_plan",
              kind: "Item",
              ids: ["n7"],
              schemaFence: {
                graphId: "edge_endpoint_delete_plan",
                expectedVersion: 1,
              },
            },
            "2026-02-01T00:00:00.000Z",
            sql.raw(""),
          ),
        ),
      );
    },
  );
});
