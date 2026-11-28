/** The shared no-op statement that acquires SQLite's transaction writer slot. */
import { sql, type SqlFragment } from "../query/sql-fragment";
import {
  asCompiledWriteStatementSql,
  type CompiledStatementSql,
} from "../query/sql-intent";

/** No graph row changes; its UPDATE still reserves the connection's slot. */
export function engineSerializedWriterSlotStatement(
  nodesTable: SqlFragment,
): CompiledStatementSql {
  // A write: it takes SQLite's writer slot, so a read-only scope refuses it.
  return asCompiledWriteStatementSql(
    sql`UPDATE ${nodesTable} SET graph_id = graph_id WHERE 0`,
  );
}
