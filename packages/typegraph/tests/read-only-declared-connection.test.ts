/**
 * A read-only transaction on a connection only a `serializedResource`
 * declaration identifies.
 *
 * Two owners decide this case together:
 *
 * - `resolveConnectionIdentity` (`src/backend/transaction-resource.ts`) is
 *   the one answer to "which connection does this handle run on". For a
 *   handle no driver predicate recognizes (`sqlite-proxy`), a
 *   `{ mode: "shared", resource }` declaration names `resource`, and every
 *   wrapper declaring it names the same connection. A declared connection is
 *   never proof of a transaction: no token is published or verified through
 *   it, so no session joins a transaction's state through it.
 * - The read-only scope a read-only `store.transaction` opens is also held on
 *   its transaction's connection (`native-transaction-state.ts`), and a bind
 *   of a handle nothing proved reads as read-only while a scope is held on
 *   the connection it runs on: a connection runs one transaction at a time.
 *
 * So a second declared wrapper over the same resource that adopts its OWN
 * handle during the read-only transaction is not joined to the
 * transaction's state, and its writes are refused before any statement.
 * Its root backend carries no gate and runs as on main. Without a
 * declaration nothing names the two wrappers as one connection, and the
 * adoption writes as on main.
 *
 * These cases run on SQLite only: a declaration reaches the native record
 * only for a connection-level handle. Every PostgreSQL handle an adoption
 * takes is a transaction object, whose proof is the object itself.
 */
import Database from "better-sqlite3";
import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";
import { afterEach, describe, expect, it } from "vitest";

import { asNodeId, createAdapterStoreWithSchema } from "../src";
import { type AnySqliteDatabase } from "../src/backend/drizzle/execution";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import {
  type SerializedResourceDeclaration,
  sharesSerializedTransactionResource,
} from "../src/backend/transaction-resource";
import { UnsupportedBackendCapabilityError } from "../src/errors";
import {
  enterTransactionOperation,
  operationEntrySession,
} from "../src/store/operation-scope";
import { requireDefined } from "../src/utils/presence";
import {
  buildGraph,
  seed,
} from "./backends/integration/read-only-transaction-writes";

/**
 * One row as both shapes `sqlite-proxy` consumers read: an array in column
 * order for a Drizzle builder query, which maps fields by position, carrying
 * each column by name too for a raw statement, which reads by name.
 */
function proxyRow(row: Readonly<Record<string, unknown>>): unknown[] {
  return Object.assign(Object.values(row), row);
}

/** A `sqlite-proxy` wrapper whose statements run on `client`, logged. */
function createProxyOver(
  client: Database.Database,
  log: string[],
): AnySqliteDatabase {
  return drizzleSqliteProxy((sql, params, method) => {
    log.push(sql);
    const statement = client.prepare(sql);
    const bound = params as readonly unknown[];
    if (!statement.reader) {
      statement.run(...bound);
      return Promise.resolve({ rows: [] });
    }
    if (method === "get") {
      const row = statement.get(...bound) as
        Readonly<Record<string, unknown>> | undefined;
      return Promise.resolve({
        rows: row === undefined ? undefined : proxyRow(row),
      } as unknown as { rows: unknown[] });
    }
    const rows = statement.all(...bound) as Readonly<Record<string, unknown>>[];
    return Promise.resolve({ rows: rows.map((row) => proxyRow(row)) });
  });
}

const clients: Database.Database[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

let graphIdCounter = 0;

async function setUp(declare: boolean) {
  const client = new Database(":memory:");
  clients.push(client);
  const firstLog: string[] = [];
  const secondLog: string[] = [];
  const firstDb = createProxyOver(client, firstLog);
  const secondDb = createProxyOver(client, secondLog);
  const declaration: SerializedResourceDeclaration | undefined =
    declare ?
      { mode: "shared", resource: { name: "the far side's one connection" } }
    : undefined;
  const options =
    declaration === undefined ? {} : { serializedResource: declaration };
  const first = createSqliteBackend(firstDb, options);
  const second = createSqliteBackend(secondDb, options);
  graphIdCounter += 1;
  const graph = buildGraph(`ro_declared_${graphIdCounter}`);
  const [firstStore] = await createAdapterStoreWithSchema(graph, first);
  await seed(firstStore);
  const [secondStore] = await createAdapterStoreWithSchema(graph, second);
  return { first, second, firstStore, secondStore, secondDb, secondLog };
}

/** The native-transaction state a transaction context's session holds. */
function stateOf(context: Parameters<typeof enterTransactionOperation>[0]) {
  return requireDefined(
    operationEntrySession(enterTransactionOperation(context)),
  ).native;
}

/** The rejection of `write`, or `undefined` when it fulfilled. */
async function rejectionOf(write: Promise<unknown>): Promise<unknown> {
  try {
    await write;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("a read-only transaction on a declared connection, adopted through a second declared wrapper", () => {
  it("refuses a write through the second wrapper's adoption before any statement, without joining the transaction, and leaves a later read-write transaction writable through it", async () => {
    const { first, second, firstStore, secondStore, secondDb, secondLog } =
      await setUp(true);
    expect(sharesSerializedTransactionResource(first, second)).toBe(true);

    const adopted = secondStore.withTransaction(secondDb);
    const observed = await firstStore.transaction(
      async (tx) => {
        const statementsBefore = secondLog.length;
        const refusal = await rejectionOf(
          adopted.nodes.RotTeam.create({ name: "t3" }, { id: "t3" }),
        );
        return {
          refusal,
          statements: secondLog.slice(statementsBefore),
          joined: stateOf(adopted) === stateOf(tx),
        };
      },
      { accessMode: "read_only" },
    );

    expect(observed.refusal).toBeInstanceOf(UnsupportedBackendCapabilityError);
    expect(
      (observed.refusal as UnsupportedBackendCapabilityError).details,
    ).toMatchObject({
      capability: "write transaction access",
      accessMode: "read_only",
    });
    expect(observed.statements).toEqual([]);
    expect(observed.joined).toBe(false);
    expect(await firstStore.nodes.RotTeam.getById(asNodeId("t3"))).toBe(
      undefined,
    );

    // The scope is released with the transaction: the same adoption writes
    // in a later read-write transaction.
    await firstStore.transaction(async () => {
      await adopted.nodes.RotTeam.create({ name: "t4" }, { id: "t4" });
    });
    const written = await firstStore.nodes.RotTeam.getById(asNodeId("t4"));
    expect(written?.id).toBe("t4");
  });

  it("leaves a root call through the second wrapper during the read-only transaction to the driver, as on main", async () => {
    const { firstStore, secondStore, secondLog } = await setUp(true);
    const observed = await firstStore.transaction(
      async () => {
        const statementsBefore = secondLog.length;
        const outcome = await rejectionOf(
          secondStore.nodes.RotTeam.create({ name: "t5" }, { id: "t5" }),
        );
        return { outcome, statements: secondLog.slice(statementsBefore) };
      },
      { accessMode: "read_only" },
    );
    // A root backend carries no gate: its unit opens its own transaction on
    // the driver, which here is the one connection the read-only
    // transaction holds, so the driver refuses the nested BEGIN exactly as
    // it does on main.
    expect(observed.outcome).not.toBeInstanceOf(
      UnsupportedBackendCapabilityError,
    );
    expect(observed.statements[0]).toBe("BEGIN IMMEDIATE");
    expect(String((observed.outcome as Error).cause)).toContain(
      "cannot start a transaction within a transaction",
    );
  });

  it("leaves the second wrapper's adoption to write as on main when no declaration names the two as one connection", async () => {
    const { first, second, firstStore, secondStore, secondDb } =
      await setUp(false);
    expect(sharesSerializedTransactionResource(first, second)).toBe(false);
    const adopted = secondStore.withTransaction(secondDb);
    const outcome = await firstStore.transaction(
      async () =>
        rejectionOf(adopted.nodes.RotTeam.create({ name: "t6" }, { id: "t6" })),
      { accessMode: "read_only" },
    );
    expect(outcome).toBe(undefined);
    const written = await firstStore.nodes.RotTeam.getById(asNodeId("t6"));
    expect(written?.id).toBe("t6");
  });
});
