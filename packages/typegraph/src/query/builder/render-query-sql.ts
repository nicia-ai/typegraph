import { ConfigurationError } from "../../errors";
import type { StatementBackend } from "../../store/operation-scope";
import type { CompiledSelectSql } from "../sql-intent";

/** Keeps SQL-rendering capability checks shared by projection and relation execution. */
export function renderQuerySql(
  backend: StatementBackend,
  compile: () => CompiledSelectSql,
): Readonly<{ sql: string; params: readonly unknown[] }> {
  if (backend.compileSql === undefined)
    throw new ConfigurationError("The backend cannot render SQL text.");
  return backend.compileSql(compile());
}
