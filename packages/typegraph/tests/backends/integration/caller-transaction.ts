/**
 * Helpers for cases that run TypeGraph on a caller's own PostgreSQL
 * transaction: the caller sets its own settings, hands TypeGraph a backend
 * built over that transaction, reads what is left behind on the same
 * transaction, and rolls it back so nothing the case provisions survives.
 */
import type { GraphDef } from "../../../src";
import { createPostgresTables } from "../../../src/backend/drizzle/schema/postgres";
import { createPostgresBackend } from "../../../src/backend/postgres";
import {
  createPostgresWorkingCopyManager,
  type PostgresWorkingCopyManager,
} from "../../../src/backend/postgres/working-copy";
import type {
  AdapterBackend,
  GraphBackend,
  TransactionBackend,
} from "../../../src/backend/types";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import type { IntegrationTestContext } from "./test-context";

export type SkipContext = Readonly<{ skip: (note?: string) => never }>;

/** Builds a backend over the caller's transaction. */
export type OverCaller = (
  options?: Parameters<typeof createPostgresBackend>[1],
) => GraphBackend;

/** The caller's own values, neither of them a server default. */
export const CALLER_WORK_MEM = "5MB";
export const CALLER_LOCK_TIMEOUT = "7s";

export async function run(
  session: TransactionBackend,
  statement: ReturnType<typeof sql>,
): Promise<readonly Record<string, unknown>[]> {
  return session.execute(asCompiledRowsSql(statement));
}

/** The caller session's current schema. */
export async function currentSchema(
  session: TransactionBackend,
): Promise<string> {
  const [current] = await run(
    session,
    sql`SELECT current_schema()::text AS schema`,
  );
  return String(current?.["schema"]);
}

/** Every table and sequence outside the system schemas, as `schema.name`. */
export async function userRelations(
  session: TransactionBackend,
): Promise<readonly string[]> {
  const found = await run(
    session,
    sql`SELECT n.nspname::text || '.' || c.relname::text AS relation FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p', 'S') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%' ORDER BY 1`,
  );
  return found.map((row) => String(row["relation"]));
}

/**
 * Rows in the working-copy ledger held by `ledgerSchema`: every row, or the
 * one row of `allocationId`.
 */
export async function liveAllocations(
  session: TransactionBackend,
  ledgerSchema: string,
  allocationId?: string,
): Promise<number> {
  const [ledger] = await run(
    session,
    allocationId === undefined ?
      sql`SELECT count(*)::int AS live FROM ${sql.identifier(ledgerSchema)}.typegraph_working_copy_allocations`
    : sql`SELECT count(*)::int AS live FROM ${sql.identifier(ledgerSchema)}.typegraph_working_copy_allocations WHERE allocation_id = ${allocationId}`,
  );
  return Number(ledger?.["live"]);
}

const ROLLBACK = new Error("roll the caller's transaction back");

export function requirePostgres(
  context: IntegrationTestContext,
  ctx: SkipContext,
): AdapterBackend<unknown> {
  const backend = context.getBackend();
  if (backend.dialect !== "postgres") {
    ctx.skip("this case runs on a caller's PostgreSQL transaction");
  }
  return backend;
}

/**
 * Runs `body` in a caller's native transaction that has set its own
 * `work_mem` and `lock_timeout`, hands it a backend over that transaction,
 * and rolls the transaction back afterwards.
 */
export async function inCallerTransaction<T>(
  root: AdapterBackend<unknown>,
  body: (caller: TransactionBackend, overCaller: OverCaller) => Promise<T>,
): Promise<T> {
  const outcome: { value?: T } = {};
  await root
    .transactionWithNative(async (caller, native) => {
      await run(
        caller,
        sql`SELECT set_config('work_mem', ${CALLER_WORK_MEM}, true), set_config('lock_timeout', ${CALLER_LOCK_TIMEOUT}, true)`,
      );
      outcome.value = await body(caller, (options) =>
        createPostgresBackend(native as never, options),
      );
      throw ROLLBACK;
    })
    .catch((error: unknown) => {
      if (error !== ROLLBACK) throw error;
    });
  return outcome.value as T;
}

/** A working-copy manager whose connections run on the caller's transaction. */
export function managerOver<G extends GraphDef>(
  control: GraphBackend,
  overCaller: OverCaller,
  connect?: () => Promise<GraphBackend>,
): PostgresWorkingCopyManager<G> {
  return createPostgresWorkingCopyManager<G>({
    control,
    connect: (names) =>
      connect?.() ??
      Promise.resolve(
        overCaller({ vector: false, tables: createPostgresTables(names) }),
      ),
  });
}

/** The error `promise` rejects with, or undefined when it fulfils. */
export async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}
