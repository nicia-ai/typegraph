/**
 * PreparedQuery — a pre-compiled, parameterized query.
 *
 * Created via `ExecutableQuery.prepare()`. Compiles the query AST to SQL once
 * at prepare time, then executes with different parameter bindings on each call.
 *
 * Fast path: when `backend.executeRaw` is available, executes pre-compiled SQL
 * text directly with substituted parameter values.
 *
 * Fallback: substitutes parameter refs in the AST, recompiles to SQL, and
 * executes via the standard `backend.execute` path.
 */
import { type GraphBackend } from "../../backend/types";
import { UnsupportedPredicateError } from "../../errors";
import {
  type BetweenPredicate,
  type ComparisonPredicate,
  type LiteralValue,
  type ParameterRef,
  type PredicateExpression,
  type QueryAst,
  type SelectiveField,
  type StringPredicate,
} from "../ast";
import { compileQuery, type CompileQueryOptions } from "../compiler/index";
import type { SqlDialect } from "../dialect/types";
import {
  mapResults,
  mapSelectiveResults,
  MissingSelectiveFieldError,
  transformPathColumns,
} from "../execution";
import { type SchemaIntrospector } from "../schema-introspector";
import {
  type AliasMap,
  type EdgeAliasMap,
  type QueryBuilderState,
  type SelectContext,
} from "./types";

// ============================================================
// Parameter Substitution
// ============================================================

function isParameterRef(value: unknown): value is ParameterRef {
  if (typeof value !== "object" || value === null) return false;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard for untyped input
  return (value as ParameterRef).__type === "parameter";
}

function toLiteral(value: unknown): LiteralValue {
  if (value instanceof Date) {
    return { __type: "literal", value: value.toISOString(), valueType: "date" };
  }
  if (typeof value === "string") {
    return { __type: "literal", value, valueType: "string" };
  }
  if (typeof value === "number") {
    return { __type: "literal", value, valueType: "number" };
  }
  if (typeof value === "boolean") {
    return { __type: "literal", value, valueType: "boolean" };
  }
  throw new Error(`Unsupported parameter value type: ${typeof value}`);
}

/**
 * Walks a predicate expression tree and replaces ParameterRef nodes
 * with LiteralValue nodes using the provided bindings.
 */
function substitutePredicateExpression(
  expr: PredicateExpression,
  bindings: Readonly<Record<string, unknown>>,
): PredicateExpression {
  switch (expr.__type) {
    case "comparison": {
      if (isParameterRef(expr.right)) {
        const value = bindings[expr.right.name];
        if (value === undefined) {
          throw new Error(`Missing binding for parameter "${expr.right.name}"`);
        }
        return {
          ...expr,
          right: toLiteral(value),
        } satisfies ComparisonPredicate;
      }
      return expr;
    }

    case "string_op": {
      if (isParameterRef(expr.pattern)) {
        const value = bindings[expr.pattern.name];
        if (value === undefined) {
          throw new Error(
            `Missing binding for parameter "${expr.pattern.name}"`,
          );
        }
        if (typeof value !== "string") {
          throw new TypeError(
            `Parameter "${expr.pattern.name}" must be a string for string operations`,
          );
        }
        return {
          ...expr,
          pattern: value,
        } satisfies StringPredicate;
      }
      return expr;
    }

    case "between": {
      const lowerIsParam = isParameterRef(expr.lower);
      const upperIsParam = isParameterRef(expr.upper);
      if (!lowerIsParam && !upperIsParam) return expr;

      const lower =
        lowerIsParam ?
          toLiteral(resolveBinding(bindings, expr.lower.name))
        : expr.lower;
      const upper =
        upperIsParam ?
          toLiteral(resolveBinding(bindings, expr.upper.name))
        : expr.upper;
      return { ...expr, lower, upper } satisfies BetweenPredicate;
    }

    case "and": {
      return {
        ...expr,
        predicates: expr.predicates.map((p) =>
          substitutePredicateExpression(p, bindings),
        ),
      };
    }

    case "or": {
      return {
        ...expr,
        predicates: expr.predicates.map((p) =>
          substitutePredicateExpression(p, bindings),
        ),
      };
    }

    case "not": {
      return {
        ...expr,
        predicate: substitutePredicateExpression(expr.predicate, bindings),
      };
    }

    // These predicate types don't contain ParameterRef nodes
    case "null_check":
    case "array_op":
    case "object_op":
    case "aggregate_comparison":
    case "exists":
    case "in_subquery":
    case "vector_similarity": {
      return expr;
    }
  }
}

function resolveBinding(
  bindings: Readonly<Record<string, unknown>>,
  name: string,
): unknown {
  const value = bindings[name];
  if (value === undefined) {
    throw new Error(`Missing binding for parameter "${name}"`);
  }
  return value;
}

/**
 * Substitutes all ParameterRef nodes in a QueryAst with concrete values.
 */
function substituteParameters(
  ast: QueryAst,
  bindings: Readonly<Record<string, unknown>>,
): QueryAst {
  return {
    ...ast,
    predicates: ast.predicates.map((pred) => ({
      ...pred,
      expression: substitutePredicateExpression(pred.expression, bindings),
    })),
  };
}

// ============================================================
// Placeholder Substitution for executeRaw Fast Path
// ============================================================

/**
 * Fills placeholder values in a parameter array.
 *
 * Drizzle's `sql.placeholder()` produces `Placeholder` objects in the params
 * array. This function replaces them with the actual bound values.
 */
function fillPlaceholders(
  params: readonly unknown[],
  bindings: Readonly<Record<string, unknown>>,
): unknown[] {
  return params.map((parameter) => {
    if (
      typeof parameter === "object" &&
      parameter !== null &&
      "name" in parameter &&
      typeof (parameter as { name: unknown }).name === "string"
    ) {
      const name = (parameter as { name: string }).name;
      const value = bindings[name];
      if (value === undefined) {
        throw new Error(`Missing binding for parameter "${name}"`);
      }
      return value instanceof Date ? value.toISOString() : value;
    }
    return parameter;
  });
}

// ============================================================
// PreparedQuery
// ============================================================

type PreparedQueryConfig<R> = Readonly<{
  ast: QueryAst;
  unoptimizedAst: QueryAst;
  sqlText: string | undefined;
  sqlParams: readonly unknown[] | undefined;
  unoptimizedSqlText: string | undefined;
  unoptimizedSqlParams: readonly unknown[] | undefined;
  backend: GraphBackend;
  dialect: SqlDialect;
  graphId: string;
  compileOptions: CompileQueryOptions;
  state: QueryBuilderState;
  selectiveFields: readonly SelectiveField[] | undefined;
  selectFn: (context: SelectContext<AliasMap, EdgeAliasMap>) => R;
  schemaIntrospector: SchemaIntrospector;
}>;

/**
 * A pre-compiled, parameterized query.
 *
 * @example
 * ```typescript
 * const prepared = store.query()
 *   .from("Person", "p")
 *   .whereNode("p", (p) => p.name.eq(param("name")))
 *   .select((ctx) => ctx.p)
 *   .prepare();
 *
 * // Execute with different bindings
 * const alice = await prepared.execute({ name: "Alice" });
 * const bob = await prepared.execute({ name: "Bob" });
 * ```
 */
export class PreparedQuery<R> {
  readonly #ast: QueryAst;
  readonly #unoptimizedAst: QueryAst;
  readonly #sqlText: string | undefined;
  readonly #sqlParams: readonly unknown[] | undefined;
  readonly #unoptimizedSqlText: string | undefined;
  readonly #unoptimizedSqlParams: readonly unknown[] | undefined;
  readonly #backend: GraphBackend;
  readonly #dialect: SqlDialect;
  readonly #graphId: string;
  readonly #compileOptions: CompileQueryOptions;
  readonly #state: QueryBuilderState;
  readonly #selectiveFields: readonly SelectiveField[] | undefined;
  readonly #selectFn: (context: SelectContext<AliasMap, EdgeAliasMap>) => R;
  readonly #schemaIntrospector: SchemaIntrospector;
  readonly #parameterNames: ReadonlySet<string>;
  #selectiveEnabled: boolean;

  constructor(config: PreparedQueryConfig<R>) {
    this.#ast = config.ast;
    this.#unoptimizedAst = config.unoptimizedAst;
    this.#sqlText = config.sqlText;
    this.#sqlParams = config.sqlParams;
    this.#unoptimizedSqlText = config.unoptimizedSqlText;
    this.#unoptimizedSqlParams = config.unoptimizedSqlParams;
    this.#backend = config.backend;
    this.#dialect = config.dialect;
    this.#graphId = config.graphId;
    this.#compileOptions = config.compileOptions;
    this.#state = config.state;
    this.#selectiveFields = config.selectiveFields;
    this.#selectFn = config.selectFn;
    this.#schemaIntrospector = config.schemaIntrospector;
    this.#parameterNames = collectParameterNames(this.#ast);
    this.#selectiveEnabled = config.selectiveFields !== undefined;
  }

  /**
   * Executes the prepared query with the given parameter bindings.
   *
   * @param bindings - A record mapping parameter names to their values
   * @returns The query results
   */
  async execute(
    bindings: Readonly<Record<string, unknown>> = {},
  ): Promise<readonly R[]> {
    validateBindings(bindings, this.#parameterNames);

    if (this.#selectiveEnabled && this.#selectiveFields !== undefined) {
      try {
        const rows = await this.#executeSelectiveRows(bindings);
        return mapSelectiveResults<AliasMap, EdgeAliasMap, R>(
          rows,
          this.#state,
          this.#selectiveFields,
          this.#schemaIntrospector,
          this.#selectFn,
        );
      } catch (error) {
        if (
          error instanceof MissingSelectiveFieldError ||
          error instanceof UnsupportedPredicateError
        ) {
          this.#selectiveEnabled = false;
          return this.#executeUnoptimized(bindings);
        }
        throw error;
      }
    }

    return this.#executeUnoptimized(bindings);
  }

  async #executeSelectiveRows(
    bindings: Readonly<Record<string, unknown>>,
  ): Promise<readonly Record<string, unknown>[]> {
    if (
      this.#sqlText !== undefined &&
      this.#sqlParams !== undefined &&
      this.#backend.executeRaw !== undefined
    ) {
      const filledParams = fillPlaceholders(this.#sqlParams, bindings);
      const rawRows = await this.#backend.executeRaw<Record<string, unknown>>(
        this.#sqlText,
        filledParams,
      );
      return transformPathColumns(rawRows, this.#state, this.#dialect);
    }

    const concreteAst = substituteParameters(this.#ast, bindings);
    const compiled = compileQuery(
      concreteAst,
      this.#graphId,
      this.#compileOptions,
    );
    const rawRows =
      await this.#backend.execute<Record<string, unknown>>(compiled);
    return transformPathColumns(rawRows, this.#state, this.#dialect);
  }

  async #executeUnoptimized(
    bindings: Readonly<Record<string, unknown>>,
  ): Promise<readonly R[]> {
    const rows = await this.#executeUnoptimizedRows(bindings);
    return mapResults<AliasMap, EdgeAliasMap, R>(
      rows,
      this.#state.startAlias,
      this.#state.traversals,
      this.#selectFn,
    );
  }

  async #executeUnoptimizedRows(
    bindings: Readonly<Record<string, unknown>>,
  ): Promise<readonly Record<string, unknown>[]> {
    if (
      this.#unoptimizedSqlText !== undefined &&
      this.#unoptimizedSqlParams !== undefined &&
      this.#backend.executeRaw !== undefined
    ) {
      const filledParams = fillPlaceholders(
        this.#unoptimizedSqlParams,
        bindings,
      );
      const rawRows = await this.#backend.executeRaw<Record<string, unknown>>(
        this.#unoptimizedSqlText,
        filledParams,
      );
      return transformPathColumns(rawRows, this.#state, this.#dialect);
    }

    const concreteAst = substituteParameters(this.#unoptimizedAst, bindings);
    const compiled = compileQuery(
      concreteAst,
      this.#graphId,
      this.#compileOptions,
    );
    const rawRows =
      await this.#backend.execute<Record<string, unknown>>(compiled);
    return transformPathColumns(rawRows, this.#state, this.#dialect);
  }
}

function collectParameterNames(ast: QueryAst): ReadonlySet<string> {
  const names = new Set<string>();

  for (const predicate of ast.predicates) {
    collectParameterNamesFromExpression(predicate.expression, names);
  }

  return names;
}

function collectParameterNamesFromExpression(
  expression: PredicateExpression,
  names: Set<string>,
): void {
  switch (expression.__type) {
    case "comparison": {
      if (isParameterRef(expression.right)) {
        names.add(expression.right.name);
      }
      return;
    }
    case "string_op": {
      if (isParameterRef(expression.pattern)) {
        names.add(expression.pattern.name);
      }
      return;
    }
    case "between": {
      if (isParameterRef(expression.lower)) {
        names.add(expression.lower.name);
      }
      if (isParameterRef(expression.upper)) {
        names.add(expression.upper.name);
      }
      return;
    }
    case "and":
    case "or": {
      for (const predicate of expression.predicates) {
        collectParameterNamesFromExpression(predicate, names);
      }
      return;
    }
    case "not": {
      collectParameterNamesFromExpression(expression.predicate, names);
      return;
    }
    case "null_check":
    case "array_op":
    case "object_op":
    case "aggregate_comparison":
    case "exists":
    case "in_subquery":
    case "vector_similarity": {
      return;
    }
  }
}

function validateBindings(
  bindings: Readonly<Record<string, unknown>>,
  expectedNames: ReadonlySet<string>,
): void {
  const missing: string[] = [];
  for (const name of expectedNames) {
    if (bindings[name] === undefined) {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing bindings for parameter${missing.length === 1 ? "" : "s"}: ${missing.map((name) => `"${name}"`).join(", ")}`,
    );
  }

  const unknown = Object.keys(bindings).filter(
    (name) => !expectedNames.has(name),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unexpected bindings provided: ${unknown.map((name) => `"${name}"`).join(", ")}`,
    );
  }
}
