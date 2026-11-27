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
 * Statements that require a freshly parsed plan, including schema-sensitive
 * result projections and plans that depend on bound parameter values —
 * e.g. an id-array membership filter where the array cardinality varies
 * per call. PostgreSQL's prepared-statement machinery switches to a
 * generic (parameter-blind) plan after five executions, which for these
 * statements is catastrophically wrong (measured 21ms -> 310ms on the
 * subgraph edge fetch). Marked statements are executed unnamed so every
 * call is planned against the actual parameters; the re-parse cost is
 * ~1ms, the generic-plan cliff it avoids is 10-300ms.
 */
type SqlIntentRegistry = Readonly<{
  recursivePlanCounts?: WeakMap<SqlFragment, number>;
  columnReadNodes?: WeakMap<SqlFragment, ColumnReadNode>;
  annIndexScanQueries: WeakMap<SqlFragment, readonly string[]>;
  forceCustomPlanQueries: WeakSet<SqlFragment>;
  writeIntentQueries?: WeakSet<SqlFragment>;
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
      recursivePlanCounts: new WeakMap(),
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

// Another package instance may have initialized the registry before this
// metadata existed. Extend that registry without replacing its intent state.
const recursivePlanCounts =
  sqlIntentRegistry.recursivePlanCounts ?? new WeakMap<SqlFragment, number>();
if (sqlIntentRegistry.recursivePlanCounts === undefined)
  Object.defineProperty(sqlIntentRegistry, "recursivePlanCounts", {
    value: recursivePlanCounts,
  });

// Statements library code runs through a raw-SQL member to write. Extended
// onto a registry another package instance initialized, as above.
const writeIntentQueries =
  sqlIntentRegistry.writeIntentQueries ?? new WeakSet<SqlFragment>();
if (sqlIntentRegistry.writeIntentQueries === undefined)
  Object.defineProperty(sqlIntentRegistry, "writeIntentQueries", {
    value: writeIntentQueries,
  });

/**
 * Marks a statement library code runs through a raw-SQL member
 * (`executeStatement`) to write: the explicit write intent the read-only
 * write gate (`src/backend/read-only-write-gate.ts`) refuses inside a
 * read-only scope. Every library write that does not go through a
 * write-classified backend member is compiled through this or
 * {@link asCompiledWriteRowsSql}, at its one seam.
 */
export function asCompiledWriteStatementSql(
  query: SqlFragment,
): CompiledStatementSql {
  writeIntentQueries.add(query);
  return asCompiledStatementSql(query);
}

/**
 * {@link asCompiledWriteStatementSql} for a write that returns rows
 * (`UPDATE ... RETURNING`), run through `execute`.
 */
export function asCompiledWriteRowsSql(query: SqlFragment): CompiledRowsSql {
  writeIntentQueries.add(query);
  return asCompiledRowsSql(query);
}

/** Whether library code marked `query` as a write ({@link asCompiledWriteStatementSql}). */
export function hasWriteIntent(query: unknown): boolean {
  return (
    typeof query === "object" &&
    query !== null &&
    writeIntentQueries.has(query as SqlFragment)
  );
}

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

/** Compiler evidence: independent recursive plans in this fragment. */
export function recursivePlanCount(query: SqlFragment): number {
  return recursivePlanCounts.get(query) ?? 0;
}

/** Records one newly emitted recursive plan, preserving nested stages. */
export function markRecursivePlan(query: SqlFragment): void {
  recursivePlanCounts.set(query, recursivePlanCount(query) + 1);
}

/**
 * One by-name column reference a compiled statement makes, recorded by the
 * function that writes it into the SQL (`compiler/column-reads.ts`).
 */
export type SqlColumnRead = Readonly<{
  /** The column name, or `undefined` for every column (`SELECT *`). */
  name: string | undefined;
  /**
   * The relations SQL resolves the name in: the one relation a qualified
   * reference names, or every relation of the FROM an unqualified reference
   * is written under. `undefined` until the SELECT that writes an unqualified
   * reference binds it to its FROM.
   */
  relations: readonly string[] | undefined;
  /** Whether SQL writes the name with its relation. */
  qualified: boolean;
  /**
   * The expression scope of the enclosing statement a correlated reference
   * reads from; `undefined` for a read of the statement that writes it.
   */
  scope: symbol | undefined;
}>;

type ColumnReadNode = Readonly<{
  reads: readonly SqlColumnRead[];
  children: readonly ColumnReadNode[];
}>;

// Column reads ride on the fragment that spells them and on every fragment
// composed from it, as a tree shared with the sources: composing costs one
// lookup per source, not a copy of the reads.
const columnReadNodes =
  sqlIntentRegistry.columnReadNodes ??
  new WeakMap<SqlFragment, ColumnReadNode>();
if (sqlIntentRegistry.columnReadNodes === undefined)
  Object.defineProperty(sqlIntentRegistry, "columnReadNodes", {
    value: columnReadNodes,
  });

/**
 * @internal Records the column reads a freshly built fragment spells,
 * replacing any it inherited from its sources.
 */
export function setSqlColumnReads(
  fragment: SqlFragment,
  reads: readonly SqlColumnRead[],
): void {
  if (reads.length === 0) {
    columnReadNodes.delete(fragment);
    return;
  }
  columnReadNodes.set(fragment, { reads: [...reads], children: [] });
}

/** @internal Every column read a fragment's SQL spells. */
export function sqlColumnReads(
  fragment: SqlFragment,
): readonly SqlColumnRead[] {
  const root = columnReadNodes.get(fragment);
  if (root === undefined) return [];
  const reads: SqlColumnRead[] = [];
  const visited = new Set<ColumnReadNode>();
  const pending: ColumnReadNode[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (visited.has(node)) continue;
    visited.add(node);
    for (const read of node.reads) reads.push(read);
    for (const child of node.children) pending.push(child);
  }
  return reads;
}

/** @internal Copies execution semantics and compiler metadata through composition. */
export function copySqlIntents(
  target: SqlFragment,
  sources: readonly SqlFragment[],
): void {
  const readNodes: ColumnReadNode[] = [];
  for (const source of sources) {
    const node = columnReadNodes.get(source);
    if (node !== undefined) readNodes.push(node);
  }
  const [onlyNode] = readNodes;
  if (readNodes.length === 1 && onlyNode !== undefined)
    columnReadNodes.set(target, onlyNode);
  else if (readNodes.length > 1)
    columnReadNodes.set(target, { reads: [], children: readNodes });
  const recursivePlans = sources.reduce(
    (count, source) => count + recursivePlanCount(source),
    0,
  );
  if (recursivePlans > 0) recursivePlanCounts.set(target, recursivePlans);
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
