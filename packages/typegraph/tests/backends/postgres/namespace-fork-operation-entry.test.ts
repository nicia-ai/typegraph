/**
 * The namespace fork opens a session where it opens each native transaction.
 *
 * The fork holds two native transactions at once, one on the source and one
 * on the target, and it opens both on the engine directly rather than through
 * a Store. Each one opens its own session where it opens, once, and the fork
 * enters one operation of it for the statements it sends there; the same
 * holds for the transaction `abort()` opens. Operations change nothing a
 * database can observe yet, so this case watches the mints, wrapped with
 * spies that call through, against the transactions the engine handed out.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import type { GraphBackend } from "../../../src/backend/types";
import {
  forkGraphNamespace,
  prepareNamespaceForkTarget,
} from "../../../src/graph-merge/namespace-fork";
import type * as OperationScopeModule from "../../../src/store/operation-scope";
import {
  enterOperation,
  openTransactionSession,
  type TransactionSession,
} from "../../../src/store/operation-scope";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

vi.mock("../../../src/store/operation-scope", async (importOriginal) => {
  const actual: typeof OperationScopeModule = await importOriginal();
  return {
    ...actual,
    enterOperation: vi.fn(actual.enterOperation),
    openTransactionSession: vi.fn(actual.openTransactionSession),
  };
});

const enterOperationSpy = vi.mocked(enterOperation);
const openTransactionSessionSpy = vi.mocked(openTransactionSession);

const SOURCE_URL = await provisionPostgresTestDatabase(import.meta.url);
const TARGET_URL = await provisionPostgresTestDatabase(
  new URL("namespace-fork-operation-entry-target.test.ts", import.meta.url)
    .href,
);

const Item = defineNode("Item", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({
  id: "namespace-fork-operation-entry",
  nodes: { Item: { type: Item } },
  edges: {},
});

let sourcePool: Pool | undefined;
let targetPool: Pool | undefined;

beforeAll(async () => {
  if (process.env["POSTGRES_URL"] === undefined) return;
  sourcePool = new Pool({ connectionString: SOURCE_URL });
  targetPool = new Pool({ connectionString: TARGET_URL });
  await sourcePool.query(generatePostgresMigrationSQL());
  await targetPool.query(generatePostgresMigrationSQL());
});

afterAll(async () => {
  await sourcePool?.end();
  await targetPool?.end();
});

/**
 * Records every transaction object `backend.transaction` hands its callback
 * while `record` runs, in the order they were opened.
 */
async function transactionsOpenedBy<T>(
  backends: readonly GraphBackend[],
  record: () => Promise<T>,
): Promise<readonly object[]> {
  const opened: object[] = [];
  const spies = backends.map((backend) => {
    const transaction = backend.transaction;
    return vi.spyOn(backend, "transaction").mockImplementation((fn, options) =>
      transaction((tx) => {
        opened.push(tx);
        return fn(tx);
      }, options),
    );
  });
  try {
    await record();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return opened;
}

/**
 * For each transaction in `opened`: the sessions opened over it, and how many
 * operations were entered from each.
 */
function sessionsOver(opened: readonly object[]) {
  const sessions = openTransactionSessionSpy.mock.calls.flatMap(
    ([transaction], index) => {
      const result = openTransactionSessionSpy.mock.results[index];
      if (result?.type !== "return") throw new Error("mint threw");
      const session: TransactionSession = result.value;
      return opened.includes(transaction) ? [{ transaction, session }] : [];
    },
  );
  return opened.map((transaction) => {
    const over = sessions.filter((entry) => entry.transaction === transaction);
    return over.map(
      ({ session }) =>
        enterOperationSpy.mock.calls.filter(([scope]) => scope === session)
          .length,
    );
  });
}

describe.runIf(process.env["POSTGRES_URL"] !== undefined)(
  "forkGraphNamespace operation entry",
  () => {
    it("opens one session per native transaction it opens and enters one operation of each", async () => {
      if (sourcePool === undefined || targetPool === undefined)
        throw new Error("PostgreSQL test pools were not initialized");
      const sourceBackend = createPostgresBackend(drizzle(sourcePool), {
        vector: false,
      });
      const targetBackend = createPostgresBackend(drizzle(targetPool), {
        vector: false,
      });
      const [source] = await createStoreWithSchema(graph, sourceBackend, {
        history: true,
      });
      await prepareNamespaceForkTarget(source, targetBackend);
      await source.nodes.Item.create({ name: "copied" });

      enterOperationSpy.mockClear();
      openTransactionSessionSpy.mockClear();
      const aborts: (() => Promise<void>)[] = [];
      const forked = await transactionsOpenedBy(
        [sourceBackend, targetBackend],
        async () => {
          const fork = await forkGraphNamespace(
            source,
            targetBackend,
            "operation-entry",
          );
          aborts.push(() => fork.abort());
        },
      );
      // The alias probe (a source transaction and the target transaction
      // probed from it), then the copy (a source snapshot, the alias probe's
      // target transaction inside it, and the target transaction it copies
      // into): five native transactions, each one session, each entered once.
      expect(sessionsOver(forked)).toEqual([[1], [1], [1], [1], [1]]);

      enterOperationSpy.mockClear();
      openTransactionSessionSpy.mockClear();
      const retried = await transactionsOpenedBy(
        [sourceBackend, targetBackend],
        () => forkGraphNamespace(source, targetBackend, "operation-entry"),
      );
      // A retry: the alias probe, then the ledger check on the target.
      expect(sessionsOver(retried)).toEqual([[1], [1], [1]]);

      enterOperationSpy.mockClear();
      openTransactionSessionSpy.mockClear();
      const aborted = await transactionsOpenedBy([targetBackend], async () => {
        const [abort] = aborts;
        if (abort === undefined) throw new Error("fork missing");
        await abort();
      });
      expect(sessionsOver(aborted)).toEqual([[1]]);
    });
  },
);
