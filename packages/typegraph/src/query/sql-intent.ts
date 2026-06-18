import { type SQL } from "drizzle-orm";

declare const SqlIntentBrand: unique symbol;

export type SqlIntent = "rows" | "statement";

export type IntentSql<I extends SqlIntent> = SQL &
  Readonly<{ [SqlIntentBrand]: I }>;

export type CompiledRowsSql = IntentSql<"rows">;
export type CompiledSelectSql = CompiledRowsSql;
export type CompiledStatementSql = IntentSql<"statement">;

export function asCompiledRowsSql(query: SQL): CompiledRowsSql {
  return query as CompiledRowsSql;
}

export function asCompiledSelectSql(query: SQL): CompiledSelectSql {
  return asCompiledRowsSql(query);
}

export function asCompiledStatementSql(query: SQL): CompiledStatementSql {
  return query as CompiledStatementSql;
}
