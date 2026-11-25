/**
 * Which native transaction an adoption of a caller-opened transaction records
 * on the server PostgreSQL drivers, which the shared suite cannot open
 * itself: node-postgres and postgres-js give each BEGIN and each savepoint a
 * new Drizzle transaction object that runs only inside it (proof 3 of
 * `src/backend/native-transaction-handle.ts`), and keep no link from a
 * caller's savepoint to its enclosing transaction.
 *
 * Adoption runs no SQL, so the suite needs a database but no tables.
 */
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePostgresJs } from "drizzle-orm/postgres-js";
import { Pool } from "pg";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import type { AnyPgDatabase } from "../../../src/backend/drizzle/execution";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import type { NativeTransactionState } from "../../../src/store/native-transaction-state";
import { openTransactionSession } from "../../../src/store/operation-scope";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const databaseUrl = await provisionPostgresTestDatabase(import.meta.url);

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const postgresJs = postgres(databaseUrl, { max: 4 });

afterAll(async () => {
  await pool.end();
  await postgresJs.end();
});

const DRIVERS = [
  { name: "node-postgres", database: () => drizzleNodePostgres(pool) },
  { name: "postgres-js", database: () => drizzlePostgresJs(postgresJs) },
] as const;

/** A caller's Drizzle transaction handle, as either driver hands it out. */
type CallerTransaction = Readonly<{
  transaction: <T>(run: (savepoint: object) => Promise<T>) => Promise<T>;
}>;

describe.skipIf(!process.env["POSTGRES_URL"]).each(DRIVERS)(
  "native transaction of a caller-opened transaction on $name",
  ({ database }) => {
    const db = database() as unknown as AnyPgDatabase &
      Readonly<{
        transaction: <T>(
          run: (transaction: CallerTransaction) => Promise<T>,
        ) => Promise<T>;
      }>;
    const backend = createPostgresBackend(db, {
      vector: false,
      fulltext: false,
    });
    const stateOf = (handle: object): NativeTransactionState =>
      openTransactionSession(backend.adoptTransaction(handle as never)).native;

    it("resolves one state for every adoption of the transaction object, and a state of its own for a caller savepoint", async () => {
      await db.transaction(async (transaction) => {
        const enclosing = stateOf(transaction);
        expect(stateOf(transaction)).toBe(enclosing);
        await transaction.transaction((savepoint) => {
          const inSavepoint = stateOf(savepoint);
          expect(inSavepoint).not.toBe(enclosing);
          expect(stateOf(savepoint)).toBe(inSavepoint);
          return Promise.resolve();
        });
      });
    });

    it("resolves a state of its own for each of two caller transactions open at once", async () => {
      const opens: (() => void)[] = [];
      const bothOpen = new Promise<void>((resolve) => {
        opens.push(resolve);
      });
      let opened = 0;
      const observe = (): Promise<NativeTransactionState> =>
        db.transaction(async (transaction) => {
          const state = stateOf(transaction);
          opened += 1;
          if (opened === 2) for (const open of opens) open();
          await bothOpen;
          expect(stateOf(transaction)).toBe(state);
          return state;
        });
      const [first, second] = await Promise.all([observe(), observe()]);
      expect(second).not.toBe(first);
    });

    it("resolves a transaction object retained past its transaction to that ended transaction, never to the next one", async () => {
      const first = await db.transaction((transaction) =>
        Promise.resolve({ transaction, state: stateOf(transaction) }),
      );
      const next = await db.transaction((transaction) =>
        Promise.resolve({
          current: stateOf(transaction),
          retained: stateOf(first.transaction),
        }),
      );
      expect(next.current).not.toBe(first.state);
      expect(next.retained).toBe(first.state);
    });
  },
);
