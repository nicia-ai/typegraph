/**
 * A read-only `store.transaction` on a backend over a caller's PostgreSQL
 * transaction runs in a savepoint it makes read-only, and reads the mode back
 * in the same statement: a session that did not take the mode is refused with
 * a typed error before the callback runs, since the callback's raw `tx.sql`
 * writes are the engine's to refuse.
 *
 * Driver wiring, not query semantics: the session that ignores the mode is
 * simulated at the PGlite transaction's `query`, which answers the read-back
 * as a session that never applied it.
 */
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStore,
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
} from "../../../src";
import {
  createPostgresBackend,
  createPostgresTransactionBackend,
} from "../../../src/backend/postgres";
import { ConfigurationError } from "../../../src/errors-entry";

const ModeNote = defineNode("ModeNote", {
  schema: z.object({ label: z.string() }),
});
const graph = defineGraph({
  id: "pglite_read_only_savepoint_mode",
  nodes: { ModeNote: { type: ModeNote } },
  edges: {},
});

const clients: PGlite[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

/**
 * A PGlite whose transactions answer the read-back of `transaction_read_only`
 * with `answer`, or run it as written when `answer` is `undefined`.
 */
async function pgliteReadingModeAs(
  answer: string | undefined,
): Promise<PGlite> {
  const client = await PGlite.create();
  clients.push(client);
  const transaction = client.transaction.bind(client);
  client.transaction = <T>(
    callback: (tx: Transaction) => Promise<T>,
  ): Promise<T> =>
    transaction((tx) =>
      callback({
        ...tx,
        get closed() {
          return tx.closed;
        },
        query: ((text: string, params?: unknown[], options?: unknown) =>
          tx.query(
            (
              answer !== undefined &&
                text.includes("current_setting('transaction_read_only')")
            ) ?
              `SELECT 'on' AS requested_mode, '${answer}' AS transaction_read_only`
            : text,
            params,
            options as Parameters<Transaction["query"]>[2],
          )) as Transaction["query"],
      }),
    );
  return client;
}

async function readOnlySavepointOutcome(
  answer: string | undefined,
): Promise<unknown> {
  const db = drizzle(await pgliteReadingModeAs(answer));
  const [store] = await createAdapterStoreWithSchema(
    graph,
    createPostgresBackend(db),
  );
  let ran = false;
  let outcome: unknown;
  await store.transaction(async (tx) => {
    const overTransaction = createAdapterStore(
      graph,
      createPostgresTransactionBackend(
        (tx as unknown as Readonly<{ sql: never }>).sql,
      ),
    );
    try {
      await overTransaction.transaction(
        () => {
          ran = true;
          return Promise.resolve();
        },
        { accessMode: "read_only" },
      );
      outcome = "ran";
    } catch (error) {
      outcome = error;
    }
  });
  return { ran, outcome };
}

describe("a read-only savepoint on PGlite", () => {
  it("runs once the session, unchanged, reads the mode back as on", async () => {
    expect(await readOnlySavepointOutcome(undefined)).toEqual({
      ran: true,
      outcome: "ran",
    });
  });

  it("refuses with a typed error before its callback when the session did not take the mode", async () => {
    const { ran, outcome } = (await readOnlySavepointOutcome("off")) as {
      ran: boolean;
      outcome: unknown;
    };
    expect(ran).toBe(false);
    expect(outcome).toBeInstanceOf(ConfigurationError);
    expect((outcome as ConfigurationError).details).toMatchObject({
      code: "POSTGRES_READ_ONLY_MODE_NOT_TAKEN",
      transactionReadOnly: "off",
    });
  });
});
