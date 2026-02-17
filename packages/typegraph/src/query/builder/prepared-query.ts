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
import { Placeholder } from "drizzle-orm";

import { type GraphBackend } from "../../backend/types";
import { ConfigurationError, UnsupportedPredicateError } from "../../errors";
import {
  type BetweenPredicate,
  type ComparisonPredicate,
  type ComposableQuery,
  type LiteralValue,
  type PredicateExpression,
  type QueryAst,
  type SelectiveField,
  type StringPredicate,
} from "../ast";
import { compileQuery, type CompileQueryOptions } from "../compiler/index";
import { getDialect } from "../dialect";
import { type SqlDialect } from "../dialect/types";
import {
  mapResults,
  mapSelectiveResults,
  MissingSelectiveFieldError,
  transformPathColumns,
} from "../execution";
import { isParameterRef } from "../predicates";
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

function toLiteral(value: unknown): LiteralValue {
  if (value === null) {
    throw new ConfigurationError(
      "Parameter value must not be null (use undefined-based patterns instead)",
      { parameterName: "value", valueType: "null" },
    );
  }
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
  throw new ConfigurationError(
    `Unsupported parameter value type: ${typeof value}`,
    { parameterName: "value", actualType: typeof value },
  );
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
          throw new ConfigurationError(
            `Missing binding for parameter "${expr.right.name}"`,
            { parameterName: expr.right.name },
          );
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
          throw new ConfigurationError(
            `Missing binding for parameter "${expr.pattern.name}"`,
            { parameterName: expr.pattern.name },
          );
        }
        if (typeof value !== "string") {
          throw new ConfigurationError(
            `Parameter "${expr.pattern.name}" must be a string for string operations`,
            { parameterName: expr.pattern.name, actualType: typeof value },
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
    case "vector_similarity": {
      return expr;
    }

    case "exists": {
      return {
        ...expr,
        subquery: substituteParameters(expr.subquery, bindings),
      };
    }

    case "in_subquery": {
      return {
        ...expr,
        subquery: substituteParameters(expr.subquery, bindings),
      };
    }
  }
}

function resolveBinding(
  bindings: Readonly<Record<string, unknown>>,
  name: string,
): unknown {
  const value = bindings[name];
  if (value === undefined) {
    throw new ConfigurationError(`Missing binding for parameter "${name}"`, {
      parameterName: name,
    });
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
    ...(ast.having !== undefined && {
      having: substitutePredicateExpression(ast.having, bindings),
    }),
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
  dialect: SqlDialect,
): unknown[] {
  const adapter = getDialect(dialect);
  return params.map((parameter) => {
    if (parameter instanceof Placeholder) {
      const name = parameter.name as string;
      const value = bindings[name];
      if (value === undefined) {
        throw new ConfigurationError(
          `Missing binding for parameter "${name}"`,
          { parameterName: name },
        );
      }
      if (value instanceof Date) return value.toISOString();
      return adapter.bindValue(value);
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
  readonly #parameterMetadata: ParameterMetadata;

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
    this.#parameterMetadata = collectParameterMetadata(this.#ast);
  }

  /** The set of parameter names required by this prepared query. */
  get parameterNames(): ReadonlySet<string> {
    return this.#parameterMetadata.names;
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
    validateBindings(bindings, this.#parameterMetadata);

    if (this.#selectiveFields !== undefined) {
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
          // Fall back per-call without permanently disabling the optimized path,
          // since different bindings may succeed on the optimized path.
          // Note: this fallback is observable via query profiler hooks (onQueryStart
          // fires twice — once for the optimized attempt, once for the fallback).
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
      const filledParams = fillPlaceholders(
        this.#sqlParams,
        bindings,
        this.#dialect,
      );
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
        this.#dialect,
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

type ParameterMetadata = Readonly<{
  names: ReadonlySet<string>;
  /** Parameters used in string_op predicates (must receive string values). */
  stringOpParameters: ReadonlySet<string>;
}>;

function collectParameterMetadata(ast: QueryAst): ParameterMetadata {
  const names = new Set<string>();
  const stringOpParameters = new Set<string>();

  collectParameterMetadataFromAst(ast, names, stringOpParameters);

  return { names, stringOpParameters };
}

export function hasParameterReferences(ast: QueryAst): boolean {
  return collectParameterMetadata(ast).names.size > 0;
}

export function composableQueryHasParameterReferences(
  query: ComposableQuery,
): boolean {
  if ("__type" in query) {
    return (
      composableQueryHasParameterReferences(query.left) ||
      composableQueryHasParameterReferences(query.right)
    );
  }
  return hasParameterReferences(query);
}

function collectParameterMetadataFromAst(
  ast: QueryAst,
  names: Set<string>,
  stringOpParameters: Set<string>,
): void {
  for (const predicate of ast.predicates) {
    collectParameterMetadataFromExpression(
      predicate.expression,
      names,
      stringOpParameters,
    );
  }
  if (ast.having !== undefined) {
    collectParameterMetadataFromExpression(
      ast.having,
      names,
      stringOpParameters,
    );
  }
}

function collectParameterMetadataFromExpression(
  expression: PredicateExpression,
  names: Set<string>,
  stringOpParameters: Set<string>,
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
        stringOpParameters.add(expression.pattern.name);
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
        collectParameterMetadataFromExpression(
          predicate,
          names,
          stringOpParameters,
        );
      }
      return;
    }
    case "not": {
      collectParameterMetadataFromExpression(
        expression.predicate,
        names,
        stringOpParameters,
      );
      return;
    }
    case "null_check":
    case "array_op":
    case "object_op":
    case "aggregate_comparison":
    case "vector_similarity": {
      return;
    }
    case "exists": {
      collectParameterMetadataFromAst(
        expression.subquery,
        names,
        stringOpParameters,
      );
      return;
    }
    case "in_subquery": {
      collectParameterMetadataFromAst(
        expression.subquery,
        names,
        stringOpParameters,
      );
      return;
    }
  }
}

function validateBindings(
  bindings: Readonly<Record<string, unknown>>,
  metadata: ParameterMetadata,
): void {
  const { names: expectedNames, stringOpParameters } = metadata;

  const missing: string[] = [];
  for (const name of expectedNames) {
    if (bindings[name] === undefined) {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    throw new ConfigurationError(
      `Missing bindings for parameter${missing.length === 1 ? "" : "s"}: ${missing.map((name) => `"${name}"`).join(", ")}`,
      { missingParameters: missing },
    );
  }

  const unexpected = Object.keys(bindings).filter(
    (name) => !expectedNames.has(name),
  );
  if (unexpected.length > 0) {
    throw new ConfigurationError(
      `Unexpected bindings provided: ${unexpected.map((name) => `"${name}"`).join(", ")}`,
      { unexpectedParameters: unexpected },
    );
  }

  // Validate value types upfront so both the fast path (executeRaw) and the
  // fallback path (AST substitution) reject the same invalid inputs.
  for (const name of expectedNames) {
    const value = bindings[name];
    validateBindingValue(name, value, stringOpParameters.has(name));
  }
}

function validateBindingValue(
  name: string,
  value: unknown,
  isStringOp: boolean,
): void {
  if (value === null) {
    throw new ConfigurationError(
      "Parameter value must not be null (use undefined-based patterns instead)",
      { parameterName: name, valueType: "null" },
    );
  }
  if (isStringOp) {
    if (typeof value !== "string") {
      throw new ConfigurationError(
        `Parameter "${name}" must be a string for string operations`,
        { parameterName: name, actualType: typeof value },
      );
    }
    return;
  }
  if (
    value instanceof Date ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return;
  }
  throw new ConfigurationError(
    `Unsupported parameter value type: ${typeof value}`,
    { parameterName: name, actualType: typeof value },
  );
}
