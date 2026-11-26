/**
 * Every way a SQLite transaction TypeGraph opened can end without TypeGraph
 * issuing its `COMMIT` or `ROLLBACK`, each followed by a write through the
 * transaction's backend.
 *
 * The rule under test is the admission rule of the transaction's view
 * (`src/backend/drizzle/execution/transaction-view.ts`): before a statement
 * starts, a driver whose own flag reflects the engine's transaction state
 * (better-sqlite3, bun:sqlite, local libSQL) is asked whether the
 * transaction is still open, so the write after the end is refused whatever
 * ended the transaction — including a route the view never sees (a statement
 * through the native handle). Nothing the transaction wrote autocommits, and
 * the transaction rejects instead of reporting success.
 *
 * SQLite only: these routes are SQLite's (`RAISE(ROLLBACK)`, `ON CONFLICT
 * ROLLBACK`, a connection whose transaction control is shared with the
 * native handle). PostgreSQL's server refuses every statement of an aborted
 * transaction itself; the shared hazard suite pins that.
 */
import { type SQL, sql as drizzleSql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type {
  GraphBackend,
  InsertNodeParams,
} from "../../../src/backend/types";
import { TypeGraphError } from "../../../src/errors";
import { sql } from "../../../src/query/sql-fragment";
import {
  asCompiledRowsSql,
  asCompiledStatementSql,
} from "../../../src/query/sql-intent";
import { requireDefined } from "../../../src/utils/presence";
import type { IntegrationTestContext } from "./test-context";

let graphCounter = 0;

function nextGraphId(): string {
  graphCounter += 1;
  return `sqlite_engine_end_${graphCounter}`;
}

function node(graphId: string, id: string): InsertNodeParams {
  return { graphId, kind: "EeItem", id, props: { label: id } };
}

/** A settled call as its error class, `"fulfilled"` or `"untyped: …"`. */
async function outcomeOf(pending: Promise<unknown>): Promise<string> {
  try {
    await pending;
    return "fulfilled";
  } catch (error) {
    return error instanceof TypeGraphError ?
        error.name
      : `untyped: ${String(error)}`;
  }
}

async function nodeIds(
  backend: GraphBackend,
  graphId: string,
): Promise<readonly string[]> {
  const rows = await backend.execute<{ id: string }>(
    asCompiledRowsSql(sql`
      SELECT id FROM ${sql.identifier(requireDefined(backend.tableNames).nodes)}
      WHERE graph_id = ${graphId} ORDER BY id
    `),
  );
  return rows.map((row) => row.id);
}

/** A Drizzle SQLite handle as the native handle of a transaction is. */
type NativeSqliteHandle = Readonly<{ run: (query: SQL) => unknown }>;

function isNativeSqliteHandle(value: unknown): value is NativeSqliteHandle {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Readonly<{ run?: unknown }>).run === "function"
  );
}

/** Runs `text` on the native handle, as a caller's own statement. */
async function runNative(native: unknown, text: string): Promise<void> {
  if (!isNativeSqliteHandle(native)) {
    throw new TypeError("expected a Drizzle SQLite handle");
  }
  await native.run(drizzleSql.raw(text));
}

/** A failure, swallowed: the callback catches it and carries on. */
async function swallow(pending: Promise<unknown>): Promise<string> {
  return outcomeOf(pending);
}

/**
 * The trigger name and teardown for a `RAISE(ROLLBACK)` trigger on inserting
 * node `"engine-rollback"` into `graphId`.
 */
async function installRaiseRollback(
  backend: GraphBackend,
  graphId: string,
): Promise<() => Promise<void>> {
  const executeDdl = requireDefined(backend.executeDdl);
  const trigger = `tg_ee_raise_${graphCounter}`;
  await executeDdl(
    `CREATE TRIGGER ${trigger} BEFORE INSERT ON "${requireDefined(backend.tableNames).nodes}"
     WHEN NEW.graph_id = '${graphId}' AND NEW.id = 'engine-rollback'
     BEGIN SELECT RAISE(ROLLBACK, 'engine ended the transaction'); END`,
  );
  return async () => {
    await executeDdl(`DROP TRIGGER ${trigger}`);
  };
}

function isSqliteLane(context: IntegrationTestContext): boolean {
  return context.driver === "better-sqlite3" || context.driver === "libsql";
}

export function registerTransactionStatementAdmissionTests(
  context: IntegrationTestContext,
): void {
  describe("a SQLite transaction that ends without TypeGraph's COMMIT or ROLLBACK", () => {
    it("refuses the next write after a native statement's trigger RAISE(ROLLBACK), and saves nothing", async () => {
      if (!isSqliteLane(context)) return;
      const backend = context.getBackend();
      const graphId = nextGraphId();
      const removeTrigger = await installRaiseRollback(backend, graphId);
      try {
        let nativeFailure = "never issued";
        let later = "never issued";
        const transaction = await outcomeOf(
          backend.transactionWithNative(async (tx, native) => {
            await tx.insertNode(node(graphId, "first"));
            // A native INSERT the view never sees fires the trigger, which
            // ends the transaction in the engine; the callback carries on.
            nativeFailure = await swallow(
              runNative(
                native,
                `INSERT INTO "${requireDefined(backend.tableNames).nodes}"
                   (graph_id, kind, id, props, version, created_at, updated_at)
                 VALUES ('${graphId}', 'EeItem', 'engine-rollback', '{}', 1,
                   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
              ),
            );
            later = await outcomeOf(tx.insertNode(node(graphId, "later")));
          }),
        );
        expect({
          nativeFailed: nativeFailure.startsWith("untyped"),
          later,
          transaction,
          nodes: await nodeIds(backend, graphId),
        }).toEqual({
          nativeFailed: true,
          later: "TransactionOutcomeUnknownError",
          transaction: "TransactionOutcomeUnknownError",
          nodes: [],
        });
      } finally {
        await removeTrigger();
      }
    });

    it.each(["ROLLBACK", "COMMIT"] as const)(
      "refuses the next write after the caller sends %s through the native handle",
      async (control) => {
        if (!isSqliteLane(context)) return;
        const backend = context.getBackend();
        const graphId = nextGraphId();
        let later = "never issued";
        const transaction = await outcomeOf(
          backend.transactionWithNative(async (tx, native) => {
            await tx.insertNode(node(graphId, "first"));
            await runNative(native, control);
            later = await outcomeOf(tx.insertNode(node(graphId, "later")));
          }),
        );
        expect({
          later,
          transaction,
          nodes: await nodeIds(backend, graphId),
        }).toEqual({
          later: "TransactionOutcomeUnknownError",
          transaction: "TransactionOutcomeUnknownError",
          // The caller's own COMMIT saved what preceded it; nothing after it
          // ran in autocommit.
          nodes: control === "COMMIT" ? ["first"] : [],
        });
      },
    );

    it.each(["ROLLBACK", "COMMIT"] as const)(
      "refuses the next write after the caller sends %s through the transaction backend's raw SQL",
      async (control) => {
        if (!isSqliteLane(context)) return;
        const backend = context.getBackend();
        const graphId = nextGraphId();
        let later = "never issued";
        const transaction = await outcomeOf(
          backend.transaction(async (tx) => {
            await tx.insertNode(node(graphId, "first"));
            await requireDefined(tx.executeStatement)(
              asCompiledStatementSql(sql.raw(control)),
            );
            later = await outcomeOf(tx.insertNode(node(graphId, "later")));
          }),
        );
        expect({
          later,
          transaction,
          nodes: await nodeIds(backend, graphId),
        }).toEqual({
          later: "TransactionOutcomeUnknownError",
          transaction: "TransactionOutcomeUnknownError",
          nodes: control === "COMMIT" ? ["first"] : [],
        });
      },
    );

    it("refuses the next write after an ON CONFLICT ROLLBACK constraint failure, and saves nothing", async () => {
      if (!isSqliteLane(context)) return;
      const backend = context.getBackend();
      const graphId = nextGraphId();
      const table = `ee_conflict_rollback_${graphCounter}`;
      const executeDdl = requireDefined(backend.executeDdl);
      await executeDdl(
        `CREATE TABLE ${table} (k TEXT UNIQUE ON CONFLICT ROLLBACK)`,
      );
      try {
        let conflict = "never issued";
        let later = "never issued";
        const transaction = await outcomeOf(
          backend.transaction(async (tx) => {
            await tx.insertNode(node(graphId, "first"));
            const insert = asCompiledRowsSql(
              sql`INSERT INTO ${sql.identifier(table)} (k) VALUES ('a') RETURNING k`,
            );
            await tx.execute(insert);
            conflict = await swallow(tx.execute(insert));
            later = await outcomeOf(tx.insertNode(node(graphId, "later")));
          }),
        );
        expect({
          conflictFailed: conflict.startsWith("untyped"),
          later,
          transaction,
          nodes: await nodeIds(backend, graphId),
        }).toEqual({
          conflictFailed: true,
          later: "TransactionRolledBackError",
          transaction: "TransactionRolledBackError",
          nodes: [],
        });
      } finally {
        await executeDdl(`DROP TABLE ${table}`);
      }
    });
    it("refuses the next write after SQLITE_FULL rolled the transaction back, and saves nothing", async () => {
      if (!isSqliteLane(context)) return;
      const backend = context.getBackend();
      const graphId = nextGraphId();
      const table = `ee_full_${graphCounter}`;
      const executeDdl = requireDefined(backend.executeDdl);
      await executeDdl(`CREATE TABLE ${table} (v BLOB)`);
      const [original] = await backend.execute<{ max_page_count: number }>(
        asCompiledRowsSql(sql`PRAGMA max_page_count`),
      );
      try {
        let full = "never issued";
        let later = "never issued";
        const transaction = await outcomeOf(
          backend.transaction(async (tx) => {
            await tx.insertNode(node(graphId, "first"));
            // Caps the transaction's connection two pages above its size:
            // row-by-row inserts then fail with SQLITE_FULL, which SQLite
            // answers by rolling the whole transaction back.
            const [pages] = await tx.execute<{ page_count: number }>(
              asCompiledRowsSql(sql`PRAGMA page_count`),
            );
            await requireDefined(tx.executeStatement)(
              asCompiledStatementSql(
                sql.raw(
                  `PRAGMA max_page_count = ${requireDefined(pages).page_count + 2}`,
                ),
              ),
            );
            full = await swallow(
              (async () => {
                for (let row = 0; row < 100; row += 1) {
                  await requireDefined(tx.executeStatement)(
                    asCompiledStatementSql(
                      sql.raw(
                        `INSERT INTO ${table} (v) VALUES (randomblob(3000))`,
                      ),
                    ),
                  );
                }
              })(),
            );
            later = await outcomeOf(tx.insertNode(node(graphId, "later")));
          }),
        );
        expect({
          full: full.includes("SQLITE_FULL") || full.includes("full"),
          later,
          transaction,
          nodes: await nodeIds(backend, graphId),
        }).toEqual({
          full: true,
          later: "TransactionRolledBackError",
          transaction: "TransactionRolledBackError",
          nodes: [],
        });
      } finally {
        await executeDdl(
          `PRAGMA max_page_count = ${requireDefined(original).max_page_count}`,
        );
        await executeDdl(`DROP TABLE ${table}`);
      }
    });
  });

  describe("two views of one transaction's connection", () => {
    it("run their statements in the order they were submitted", async () => {
      const backend = context.getBackend();
      const table = `ee_submission_order_${nextGraphId()}`;
      const executeDdl = requireDefined(backend.executeDdl);
      await executeDdl(`CREATE TABLE ${table} (k TEXT NOT NULL)`);
      try {
        const counted = await backend.transactionWithNative(
          async (tx, native) => {
            const adopted = backend.adoptTransaction(native);
            const insert = (k: string) =>
              tx.execute<{ k: string }>(
                asCompiledRowsSql(
                  sql`INSERT INTO ${sql.identifier(table)} (k) VALUES (${k}) RETURNING k`,
                ),
              );
            // A1 and A2 through the transaction's backend, then B1 through
            // a backend adopted over the same native transaction, all in one
            // turn: B1 reads after both inserts reached the connection.
            const first = insert("a1");
            const second = insert("a2");
            const read = adopted.execute<{ count: number | string }>(
              asCompiledRowsSql(
                sql`SELECT COUNT(*) AS count FROM ${sql.identifier(table)}`,
              ),
            );
            await Promise.all([first, second]);
            const [row] = await read;
            return Number(requireDefined(row).count);
          },
        );
        expect(counted).toBe(2);
      } finally {
        await executeDdl(`DROP TABLE ${table}`);
      }
    });
  });
}
