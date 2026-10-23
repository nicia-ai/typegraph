import { type DatabaseSync } from "@dolthub/doltlite";
import { type SQLWrapper } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/sqlite-proxy";

/** A typed DoltLite transport; compiled SQL executes on the native handle. */
export function doltliteDatabase(connection: DatabaseSync) {
  const dialect = new SQLiteSyncDialect();
  function rawStatement(query: string | SQLWrapper) {
    const compiled =
      typeof query === "string" ?
        { sql: query, params: [] }
      : dialect.sqlToQuery(query.getSQL());
    return {
      statement: connection.prepare(compiled.sql),
      params: compiled.params,
    };
  }
  const db = drizzle((query: string, params: unknown[], method) => {
    const statement = connection.prepare(query);
    if (method === "run") {
      statement.run(...params);
      return Promise.resolve({ rows: [] });
    }
    statement.setReturnArrays(true);
    if (method === "get") {
      const row = statement.get(...params);
      // Drizzle checks for undefined here, but its callback type requires an array.
      return Promise.resolve({
        rows: row === undefined ? undefined : Object.values(row),
      } as { rows: unknown[] });
    }
    return Promise.resolve({ rows: statement.all(...params) });
  });
  type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
  type TransactionConfig = Parameters<typeof db.transaction>[1];
  function attachRawMethods<T extends { transaction: typeof db.transaction }>(
    target: T,
  ) {
    const transaction = target.transaction.bind(target);
    return Object.assign(target, {
      $client: connection,
      // sqlite-proxy's callback uses positional rows for mapped selections.
      // Raw native queries must retain names (notably PRAGMA busy_timeout).
      all<T = unknown>(query: string | SQLWrapper): Promise<T[]> {
        const { statement, params } = rawStatement(query);
        return Promise.resolve(statement.all(...params) as T[]);
      },
      get<T = unknown>(query: string | SQLWrapper): Promise<T | undefined> {
        const { statement, params } = rawStatement(query);
        return Promise.resolve(statement.get(...params) as T | undefined);
      },
      transaction<TResult>(
        run: (tx: Transaction) => Promise<TResult>,
        config?: TransactionConfig,
      ): Promise<TResult> {
        return transaction(async (tx) => run(attachRawMethods(tx)), config);
      },
    });
  }
  return attachRawMethods(db);
}
