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

/**
 * Statements whose plan includes an engine ANN index scan (the inline
 * `.similarTo(..., { approximate: true })` branch). The PostgreSQL
 * backend wraps their execution with the same pgvector GUC overrides
 * the search facade applies (`hnsw.iterative_scan = strict_order` /
 * `ivfflat.iterative_scan = relaxed_order` on pgvector >= 0.8), so a
 * filtered approximate query keeps scanning past the default ef_search
 * frontier instead of starving. Carries the slot index types so the
 * backend knows which GUCs apply. Backends without GUC semantics
 * ignore the brand.
 */
const annIndexScanQueries = new WeakMap<SQL, readonly string[]>();

export function markAnnIndexScan(
  query: SQL,
  indexTypes: readonly string[],
): void {
  annIndexScanQueries.set(query, indexTypes);
}

export function annIndexScanTypes(query: SQL): readonly string[] | undefined {
  return annIndexScanQueries.get(query);
}

/**
 * Whether a compiled statement can be run as raw text (`executeRaw`) without
 * losing execution semantics. Both brands above ride on the SQL *object* and
 * are honored only by `backend.execute`: the force-custom-plan flag makes
 * PostgreSQL re-plan against the actual parameters (opposed to reusing a
 * cached statement), and the ANN-scan brand drives the pgvector iterative-scan
 * GUC wrapper. A statement carrying either must not be flattened to text and
 * cached — callers fall back to `backend.execute`. Keeping this predicate
 * beside the brands means a future brand updates one place, not every caller.
 */
export function isRawExecutable(query: SQL): boolean {
  return (
    !shouldForceCustomPlan(query) && annIndexScanTypes(query) === undefined
  );
}
