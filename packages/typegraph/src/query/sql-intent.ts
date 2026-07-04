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

/**
 * Statements whose good plan depends on the bound parameter values —
 * e.g. an id-array membership filter where the array cardinality varies
 * per call. PostgreSQL's prepared-statement machinery switches to a
 * generic (parameter-blind) plan after five executions, which for these
 * statements is catastrophically wrong (measured 21ms -> 310ms on the
 * subgraph edge fetch). Marked statements are executed unnamed so every
 * call is planned against the actual parameters; the re-parse cost is
 * ~1ms, the generic-plan cliff it avoids is 10-300ms.
 */
const forceCustomPlanQueries = new WeakSet<SQL>();

export function markForceCustomPlan(query: SQL): void {
  forceCustomPlanQueries.add(query);
}

export function shouldForceCustomPlan(query: SQL): boolean {
  return forceCustomPlanQueries.has(query);
}
