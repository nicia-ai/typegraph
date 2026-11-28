/**
 * The keyed write of a set update binds its row keys — each row's id and the
 * token naming the stored row, which carries the row's whole stored props —
 * as one JSON value. Unbounded, that one JavaScript string grows with the set
 * and its props until it cannot be built at all. The write splits its keys
 * under the backend's `maxBoundValueBytes` budget, stays all or nothing across
 * the statements it splits into, and refuses outside a transaction rather than
 * send more than one statement there.
 *
 * Each lane is run against a small configured budget with large props, and a
 * logger on the Drizzle connection records every bound value the backend sent.
 */
import Database from "better-sqlite3";
import type { Logger } from "drizzle-orm";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  type GraphBackend,
} from "../src";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { createSqlSchema } from "../src/query/compiler/schema";
import { sql } from "../src/query/sql-fragment";
import { asCompiledSelectSql } from "../src/query/sql-intent";
import { requireDefined } from "../src/utils/presence";

/** The budget each lane is configured with. */
const BUDGET_BYTES = 4096;

/** Rows per set update: their keys need several statements under the budget. */
const ROWS = 24;

/** Each row's padding: about a quarter of the budget per key. */
const PADDING = "x".repeat(900);

const Padded = defineNode("Padded", {
  schema: z.object({ status: z.string(), padding: z.string() }),
});

const graph = defineGraph({
  id: "set_update_key_budget",
  nodes: { Padded: { type: Padded } },
  edges: {},
});

/** A keyed write's statement, by the key CTE it opens with. */
function isKeyedWrite(query: string): boolean {
  return query.includes("tg_set_keys") && query.includes("UPDATE");
}

type Lane = Readonly<{
  backend: GraphBackend;
  /** Every statement the backend sent, with its bound values. */
  statements: Readonly<{ query: string; params: readonly unknown[] }>[];
  close: () => Promise<void>;
}>;

function recordingLogger(statements: Lane["statements"]): Logger {
  return {
    logQuery(query, params) {
      statements.push({ query, params });
    },
  };
}

const LANES: readonly Readonly<{
  name: string;
  open: () => Promise<Lane>;
}>[] = [
  {
    name: "SQLite",
    open: () => {
      const local = createLocalSqliteBackend();
      const statements: Lane["statements"][number][] = [];
      const backend = createSqliteBackend(
        drizzleSqlite(recordingClient(sqliteClientOf(local.db), statements)),
        { capabilities: { maxBoundValueBytes: BUDGET_BYTES } },
      );
      return Promise.resolve({
        backend,
        statements,
        close: () => local.backend.close(),
      });
    },
  },
  {
    name: "PGlite",
    open: async () => {
      const local = await createLocalPgliteBackend({ vector: false });
      const statements: Lane["statements"][number][] = [];
      const backend = createPostgresBackend(
        drizzlePglite(local.client, { logger: recordingLogger(statements) }),
        {
          vector: false,
          capabilities: { maxBoundValueBytes: BUDGET_BYTES },
        },
      );
      return { backend, statements, close: () => local.backend.close() };
    },
  },
];

/** The better-sqlite3 connection a Drizzle database was opened over. */
function sqliteClientOf(db: object): Database.Database {
  const client: unknown = Reflect.get(db, "$client");
  if (!(client instanceof Database)) {
    throw new TypeError("Expected a better-sqlite3 connection.");
  }
  return client;
}

/**
 * `client`, recording every statement it prepares together with the values
 * each run binds. The SQLite backend runs its transactions on the client
 * directly, past a Drizzle logger.
 */
function recordingClient(
  client: Database.Database,
  statements: Lane["statements"][number][],
): Database.Database {
  const prepare = client.prepare.bind(client);
  return Object.assign(client, {
    prepare: (source: string) => {
      const statement = prepare(source);
      for (const method of ["all", "get", "run", "iterate"] as const) {
        const original = statement[method].bind(statement) as (
          ...params: unknown[]
        ) => unknown;
        Object.assign(statement, {
          [method]: (...params: unknown[]) => {
            statements.push({ query: source, params: params.flat() });
            return original(...params);
          },
        });
      }
      return statement;
    },
  });
}

/** The UTF-8 size of a bound value, or 0 for a non-text value. */
function boundBytes(value: unknown): number {
  return typeof value === "string" ? new TextEncoder().encode(value).length : 0;
}

describe.each(LANES)(
  "$name: the keyed set write under a small bound-value budget",
  (lane) => {
    let opened: Lane | undefined;

    afterEach(async () => {
      await opened?.close();
      opened = undefined;
    });

    async function seeded() {
      opened = await lane.open();
      const [store] = await createStoreWithSchema(graph, opened.backend);
      const rows = [];
      for (let index = 0; index < ROWS; index += 1) {
        rows.push(
          await store.nodes.Padded.create(
            { status: "draft", padding: `${index}:${PADDING}` },
            { id: `padded-${String(index).padStart(2, "0")}` },
          ),
        );
      }
      opened.statements.length = 0;
      return { store, rows, lane: opened };
    }

    it("writes every row, in statements whose keys each stay under the budget", async () => {
      const { store, lane: current } = await seeded();

      const { affectedCount } = await store.nodes.Padded.updateWhere({
        patch: { status: "published" },
        where: (candidate) => candidate.status.eq("draft"),
      });

      const keyedWrites = current.statements.filter((statement) =>
        isKeyedWrite(statement.query),
      );
      const published = await store.nodes.Padded.find({
        where: (candidate) => candidate.status.eq("published"),
      });
      expect({
        affectedCount,
        published: published.length,
        split: keyedWrites.length > 1,
        largestBound:
          Math.max(
            ...keyedWrites.flatMap((statement) =>
              statement.params.map((value) => boundBytes(value)),
            ),
          ) <= BUDGET_BYTES,
      }).toEqual({
        affectedCount: ROWS,
        published: ROWS,
        split: true,
        largestBound: true,
      });
    });

    it("writes no row when a row of a later statement changed after the dry-run", async () => {
      const { store, lane: current } = await seeded();
      const backend = current.backend;
      const nodesTable = createSqlSchema(backend.tableNames).nodesTable;
      const patch = { status: "published" };

      const result = await backend.transaction(async (tx) => {
        const preview = await requireDefined(tx.previewNodeSetUpdate)({
          operation: "updateWhere",
          graphId: graph.id,
          kind: "Padded",
          patch,
          candidateIds: asCompiledSelectSql(sql`
            SELECT id AS padded_id FROM ${nodesTable}
            WHERE graph_id = ${graph.id} AND kind = 'Padded'
            ORDER BY id
          `),
          candidateIdColumn: "padded_id",
        });
        // The last row, which no first statement of a split carries, changes
        // between the dry-run and the keyed write.
        const last = requireDefined(preview.rows.at(-1));
        await tx.updateNode({
          graphId: graph.id,
          kind: "Padded",
          id: last.id,
          props: { status: "draft", padding: "changed" },
          incrementVersion: true,
        });
        return requireDefined(tx.updateNodeSet)({
          graphId: graph.id,
          kind: "Padded",
          patch,
          rows: preview.rows.map((row) => ({
            id: row.id,
            rowToken: row.rowToken,
          })),
        });
      });

      const published = await store.nodes.Padded.find({
        where: (candidate) => candidate.status.eq("published"),
      });
      expect({
        affectedCount: result.affectedCount,
        published: published.length,
      }).toEqual({ affectedCount: 0, published: 0 });
    });

    it("refuses outside a transaction, naming the budget, and writes nothing", async () => {
      const { store, lane: current } = await seeded();
      const backend = current.backend;
      const nodesTable = createSqlSchema(backend.tableNames).nodesTable;
      const patch = { status: "published" };
      const preview = await requireDefined(backend.previewNodeSetUpdate)({
        operation: "updateWhere",
        graphId: graph.id,
        kind: "Padded",
        patch,
        candidateIds: asCompiledSelectSql(sql`
          SELECT id AS padded_id FROM ${nodesTable}
          WHERE graph_id = ${graph.id} AND kind = 'Padded'
        `),
        candidateIdColumn: "padded_id",
      });

      const thrown = await requireDefined(backend.updateNodeSet)({
        graphId: graph.id,
        kind: "Padded",
        patch,
        rows: preview.rows.map((row) => ({
          id: row.id,
          rowToken: row.rowToken,
        })),
      }).then(
        () => "resolved",
        (error: unknown) => error,
      );

      const published = await store.nodes.Padded.find({
        where: (candidate) => candidate.status.eq("published"),
      });
      expect({
        error:
          thrown instanceof ConfigurationError ?
            [thrown.details["code"], thrown.details["budgetBytes"]]
          : thrown,
        published: published.length,
      }).toEqual({
        error: ["SET_UPDATE_KEY_BUDGET_EXCEEDED", BUDGET_BYTES],
        published: 0,
      });
    });
  },
);
