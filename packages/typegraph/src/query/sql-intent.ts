import { typeGraphGlobalSymbol } from "../utils/global-symbol";
import { type SqlFragment } from "./sql-fragment";

declare const SqlIntentBrand: unique symbol;

export type SqlIntent = "rows" | "statement" | "temporary-statement";

export type IntentSql<I extends SqlIntent> = SqlFragment &
  Readonly<{ [SqlIntentBrand]: I }>;

export type CompiledRowsSql = IntentSql<"rows">;
export type CompiledSelectSql = CompiledRowsSql;
export type CompiledStatementSql = IntentSql<"statement">;
export type CompiledTemporaryStatementSql = IntentSql<"temporary-statement">;

export function asCompiledRowsSql(query: SqlFragment): CompiledRowsSql {
  return query as CompiledRowsSql;
}

export function asCompiledSelectSql(query: SqlFragment): CompiledSelectSql {
  return asCompiledRowsSql(query);
}

export function asCompiledStatementSql(
  query: SqlFragment,
): CompiledStatementSql {
  return query as CompiledStatementSql;
}

/**
 * Marks an internal statement that may write only connection-local temporary
 * state. This is intentionally separate from the public raw-statement intent:
 * history-enabled stores block arbitrary raw writes but iterative graph
 * operations still need to manage ephemeral working tables.
 */
export function asCompiledTemporaryStatementSql(
  query: SqlFragment,
): CompiledTemporaryStatementSql {
  return query as CompiledTemporaryStatementSql;
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
type SqlIntentRegistry = Readonly<{
  annIndexScanQueries: WeakMap<SqlFragment, readonly string[]>;
  forceCustomPlanQueries: WeakSet<SqlFragment>;
}>;

const SQL_INTENT_REGISTRY: unique symbol = typeGraphGlobalSymbol(
  "sql-intent-registry",
);
const globalWithSqlIntentRegistry = globalThis as typeof globalThis &
  Readonly<{
    [SQL_INTENT_REGISTRY]?: SqlIntentRegistry;
  }>;
const sqlIntentRegistry =
  globalWithSqlIntentRegistry[SQL_INTENT_REGISTRY] ??
  (() => {
    const registry: SqlIntentRegistry = {
      annIndexScanQueries: new WeakMap(),
      forceCustomPlanQueries: new WeakSet(),
    };
    Object.defineProperty(globalWithSqlIntentRegistry, SQL_INTENT_REGISTRY, {
      configurable: false,
      enumerable: false,
      value: registry,
      writable: false,
    });
    return registry;
  })();

export function markForceCustomPlan(query: SqlFragment): void {
  sqlIntentRegistry.forceCustomPlanQueries.add(query);
}

export function shouldForceCustomPlan(query: SqlFragment): boolean {
  return sqlIntentRegistry.forceCustomPlanQueries.has(query);
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
export function markAnnIndexScan(
  query: SqlFragment,
  indexTypes: readonly string[],
): void {
  sqlIntentRegistry.annIndexScanQueries.set(query, indexTypes);
}

export function annIndexScanTypes(
  query: SqlFragment,
): readonly string[] | undefined {
  return sqlIntentRegistry.annIndexScanQueries.get(query);
}

/** @internal Copies execution semantics when immutable fragments are composed. */
export function copySqlIntents(
  target: SqlFragment,
  sources: readonly SqlFragment[],
): void {
  if (sources.some((source) => shouldForceCustomPlan(source))) {
    markForceCustomPlan(target);
  }

  const indexTypes = new Set<string>();
  for (const source of sources) {
    for (const indexType of annIndexScanTypes(source) ?? []) {
      indexTypes.add(indexType);
    }
  }
  if (indexTypes.size > 0) markAnnIndexScan(target, [...indexTypes]);
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
export function isRawExecutable(query: SqlFragment): boolean {
  return (
    !shouldForceCustomPlan(query) && annIndexScanTypes(query) === undefined
  );
}
