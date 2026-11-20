/** The shared no-op statement that acquires SQLite's transaction writer slot. */
import { sql, type SqlFragment } from "../query/sql-fragment";
import {
  asCompiledStatementSql,
  type CompiledStatementSql,
} from "../query/sql-intent";

/** No graph row changes; its UPDATE still reserves the connection's slot. */
export function engineSerializedWriterSlotStatement(
  nodesTable: SqlFragment,
): CompiledStatementSql {
  return asCompiledStatementSql(
    sql`UPDATE ${nodesTable} SET graph_id = graph_id WHERE 0`,
  );
}
