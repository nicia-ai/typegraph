/**
 * Overlapping driver savepoint scopes on a real postgres-js transaction: once
 * the outer scope exits first, the driver has rolled back both savepoints, so
 * nothing issued afterwards may run in the enclosing transaction.
 */
import { sql as drizzleSql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresTransactionSession } from "../../../src/backend/drizzle/execution/postgres-transaction-session";
import { CompilerInvariantError } from "../../../src/errors";
import { requireDefined } from "../../../src/utils/presence";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);
const OVERLAP_CODE = "OVERLAPPING_SAVEPOINT_SCOPES";
const TABLE = "overlap_session_rows";

let client: Sql;
let db: PostgresJsDatabase;

async function settle(scope: Promise<void>): Promise<unknown> {
  const [outcome] = await Promise.allSettled([scope]);
  return outcome.status === "rejected" ? outcome.reason : outcome.value;
}

async function labels(): Promise<readonly string[]> {
  const rows = await client.unsafe<{ label: string }[]>(
    `SELECT label FROM ${TABLE} ORDER BY label`,
  );
  return rows.map((row) => row.label);
}

type OverlapOutcome = Readonly<{
  outerFailure: unknown;
  writeFailure: unknown;
  innerFailure: unknown;
  exitFailure: unknown;
}>;

/**
 * Runs the interleaving that makes the outer scope exit before the inner one,
 * then issues one statement through the session and reports what happened.
 */
async function overlapThenWrite(label: string) {
  let outcome: OverlapOutcome | undefined;
  const transactionFailure = await db
    .transaction(async (transaction) => {
      const session = createPostgresTransactionSession(transaction, undefined);
      const enterDriverScope = requireDefined(session.enterDriverScope);
      const executeCompiled = requireDefined(session.compiled.executeCompiled);
      const write = async (text: string) =>
        executeCompiled({
          sql: `INSERT INTO ${TABLE} (label) VALUES ('${text}')`,
          params: [],
        });

      let releaseSecond!: () => void;
      const secondGate = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      let secondEntered!: () => void;
      const secondStarted = new Promise<void>((resolve) => {
        secondEntered = resolve;
      });

      // The first scope exits while the second, opened inside it, is still open.
      const first = settle(enterDriverScope(() => secondStarted));
      const second = settle(
        enterDriverScope(async () => {
          secondEntered();
          await secondGate;
        }),
      );
      const outerFailure = await first;
      const writeFailure = await write(label).catch((error: unknown) => error);
      releaseSecond();
      const innerFailure = await second;
      const exitFailure = await write(`${label}-after-exit`).catch(
        (error: unknown) => error,
      );
      outcome = { outerFailure, writeFailure, innerFailure, exitFailure };
    })
    .catch((error: unknown) => error);
  return { ...requireDefined(outcome), transactionFailure };
}

describe.runIf(process.env["POSTGRES_URL"])(
  "postgres-js overlapping driver savepoint scopes",
  () => {
    beforeAll(async () => {
      client = postgres(TEST_DATABASE_URL, { max: 2 });
      db = drizzle(client);
      await db.execute(
        drizzleSql.raw(`CREATE TABLE IF NOT EXISTS ${TABLE} (label text)`),
      );
      await db.execute(drizzleSql.raw(`TRUNCATE ${TABLE}`));
    });

    afterAll(async () => {
      await client.end();
    });

    it("refuses statements after the out-of-order exit and commits nothing they would write", async () => {
      const result = await overlapThenWrite("committed-attempt");

      for (const failure of [
        result.outerFailure,
        result.writeFailure,
        result.exitFailure,
      ]) {
        expect(failure).toBeInstanceOf(CompilerInvariantError);
        expect(failure).toMatchObject({ details: { code: OVERLAP_CODE } });
      }
      // The driver's own release of the destroyed savepoint fails the inner scope.
      expect(result.innerFailure).toBeInstanceOf(Error);
      // The caller caught every refusal, so the transaction commits.
      expect(result.transactionFailure).toBeUndefined();
      expect(await labels()).toEqual([]);
    });

    it("leaves nothing behind when the caller lets the transaction roll back", async () => {
      await expect(
        db.transaction(async (transaction) => {
          const session = createPostgresTransactionSession(
            transaction,
            undefined,
          );
          const enterDriverScope = requireDefined(session.enterDriverScope);
          const executeCompiled = requireDefined(
            session.compiled.executeCompiled,
          );
          let releaseSecond!: () => void;
          const secondGate = new Promise<void>((resolve) => {
            releaseSecond = resolve;
          });
          let secondEntered!: () => void;
          const secondStarted = new Promise<void>((resolve) => {
            secondEntered = resolve;
          });
          const first = enterDriverScope(() => secondStarted);
          const second = settle(
            enterDriverScope(async () => {
              secondEntered();
              await secondGate;
            }),
          );
          await settle(first);
          try {
            await executeCompiled({
              sql: `INSERT INTO ${TABLE} (label) VALUES ('rolled-back')`,
              params: [],
            });
          } finally {
            releaseSecond();
            await second;
          }
        }),
      ).rejects.toMatchObject({ details: { code: OVERLAP_CODE } });
      expect(await labels()).toEqual([]);
    });
  },
);
