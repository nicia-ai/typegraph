/** SQL access shared by the PostgreSQL working-copy ledger and its operation evidence. */
import { sql, type SqlFragment } from "../../query/sql-fragment";
import { asCompiledRowsSql } from "../../query/sql-intent";
import type { GraphBackend } from "../types";

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
