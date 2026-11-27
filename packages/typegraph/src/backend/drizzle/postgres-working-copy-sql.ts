/** SQL access shared by the PostgreSQL working-copy ledger and its operation evidence. */
import { sql, type SqlFragment } from "../../query/sql-fragment";
import { asCompiledRowsSql } from "../../query/sql-intent";
import {
  settingScopeOfTransaction,
  type TransactionLocalSetting,
  type TransactionLocalSettingScope,
  withTransactionLocalSettings,
} from "../transaction-local-settings";
import type { GraphBackend, TransactionBackend } from "../types";

export type QuerySession = Pick<GraphBackend, "execute">;

export function rows<T>(
  session: QuerySession,
  query: SqlFragment,
): Promise<readonly T[]> {
  return session.execute<T>(asCompiledRowsSql(query));
}

export function sqlName(name: string): SqlFragment {
  return sql.identifier(name);
}

/**
 * Runs `run` with the transaction-local settings it changes ending with it:
 * the end of a transaction TypeGraph opened ends them, and on a savepoint of a
 * caller's transaction `control` was built over, the caller's values are
 * restored before `run`'s result is returned.
 */
export function withUnitSettings<T>(
  transaction: TransactionBackend,
  run: (settings: TransactionLocalSettingScope) => Promise<T>,
): Promise<T> {
  return withTransactionLocalSettings(
    { execute: (query) => rows(transaction, query) },
    settingScopeOfTransaction(transaction),
    run,
  );
}

/** The `lock_timeout` that bounds every lock wait of a ledger unit. */
export function cleanupLockTimeout(
  milliseconds: number,
): TransactionLocalSetting {
  return { name: "lock_timeout", value: `${milliseconds}ms` };
}
