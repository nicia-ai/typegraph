/**
 * PreparedQuery — a pre-validated, parameterized query.
 *
 * Created via `ExecutableQuery.prepare()`. Builds and structurally validates
 * the query AST once at prepare time (so a malformed query fails fast, before
 * the first `execute()`).
 *
 * Fast path: when the backend can compile and run raw SQL (`compileSql` +
 * `executeRaw`) AND the statement is raw-executable, it is compiled ONCE
 * into a cached template whose
 * "current" read instant and user `param()` refs are reserved placeholders
 * (see {@link buildReadInstantTemplate}). Every `execute()` fills those
 * placeholders — a fresh instant plus the call's bindings — and runs the
 * cached SQL text directly, so a reused prepared query never recompiles and
 * never freezes "now" the way a cached literal instant would (the #246
 * regression).
 *
 * Fallback: substitutes parameter refs into the AST, compiles fresh per call,
 * and executes via the standard `backend.execute` path. Taken in two cases —
 * a backend without raw execution (custom/async), and a statement that is not
 * raw-executable because its execution semantics ride on the compiled SQL
 * OBJECT rather than its text (approximate vector search's iterative-scan
 * wrapper, `subgraph()`'s force-custom-plan fetches). The second applies even
 * on PostgreSQL with `executeRaw` available; `isRawExecutable` in
 * `sql-intent.ts` is the predicate that decides it.
 */
import { type GraphBackend } from "../../backend/types";
import { ConfigurationError, UnsupportedPredicateError } from "../../errors";
import { readOwnProperty } from "../../utils/object";
import {
  type BetweenPredicate,
  type ComparisonOp,
  type ComparisonPredicate,
  type ComposableQuery,
  type LiteralValue,
  type PredicateExpression,
  type QueryAst,
  type SelectiveField,
  type StringPredicate,
  type ValueType,
} from "../ast";
import { compileQuery, type CompileQueryOptions } from "../compiler/index";
import { resolveParameterValueType } from "../compiler/predicates";
import { type SqlDialect } from "../dialect/types";
import {
  mapResults,
  mapSelectiveResults,
  MissingSelectiveFieldError,
  transformPathColumns,
} from "../execution";
import {
  collectOperandExpressions,
  type DatabaseExpression,
  isCollectRecordOperand,
  normalizeDatabaseLiteral,
} from "../expressions";
import { isParameterRef } from "../predicates";
import { type SchemaIntrospector } from "../schema-introspector";
import {
  assertListBinding,
  buildQueryTemplate,
  type CompiledTemplate,
  fillTemplateParams,
} from "./read-instant-template";
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

/** Whether a comparison operator takes a list of values rather than a scalar. */
function isListComparisonOp(op: ComparisonOp): boolean {
  return op === "in" || op === "notIn";
}

/**
 * Expands a list-valued binding into the literal array the compiler's
 * non-parameterized `in`/`notIn` path expects. Used only on the fallback
 * (no `executeRaw`) path — the fast path keeps the list packed behind a
 * single placeholder.
 */
function toLiteralList(parameterName: string, value: unknown): LiteralValue[] {
  assertListBinding(parameterName, value);
  return value.map((element) => toLiteral(element));
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
        const value = resolveBinding(bindings, expr.right.name);
        return {
          ...expr,
          right:
            isListComparisonOp(expr.op) ?
              toLiteralList(expr.right.name, value)
            : toLiteral(value),
        } satisfies ComparisonPredicate;
      }
      return expr;
    }

    case "string_op": {
      if (isParameterRef(expr.pattern)) {
        const value = readOwnProperty(bindings, expr.pattern.name);
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

    case "database_expression_predicate": {
      return {
        ...expr,
        expression: substituteDatabaseExpression(expr.expression, bindings),
      };
    }

    // These predicate types don't contain ParameterRef nodes
    case "null_check":
    case "array_op":
    case "object_op":
    case "aggregate_comparison":
    case "vector_similarity":
    case "fulltext_match": {
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

export function substituteDatabaseExpression<T, Scope extends string>(
  expression: DatabaseExpression<T, Scope>,
  bindings: Readonly<Record<string, unknown>>,
): DatabaseExpression<T, Scope> {
  const node = expression.node;
  function substitute(operand: DatabaseExpression): DatabaseExpression {
    return substituteDatabaseExpression(operand, bindings);
  }
  switch (node.kind) {
    case "parameter": {
      const value = resolveBinding(bindings, node.name);
      if (value === null) {
        throw new ConfigurationError(
          `Parameter "${node.name}" must not be null`,
          { parameterName: node.name, valueType: "null" },
        );
      }
      return {
        ...expression,
        node: {
          kind: "literal",
          value: normalizeDatabaseLiteral(value, `$parameter.${node.name}`),
        },
      };
    }
    case "arithmetic":
    case "comparison": {
      return {
        ...expression,
        node: {
          ...node,
          left: substitute(node.left),
          right: substitute(node.right),
        },
      };
    }
    case "boolean": {
      return {
        ...expression,
        node: {
          ...node,
          operands: node.operands.map((operand) =>
            substitute(operand),
          ) as readonly DatabaseExpression<boolean | undefined>[],
        },
      };
    }
    case "not":
    case "null_check":
    case "numeric_conversion": {
      const operand = substitute(node.operand);
      return {
        ...expression,
        node: { ...node, operand },
      } as DatabaseExpression<T, Scope>;
    }
    case "aggregate": {
      return node.operand === undefined ?
          expression
        : {
            ...expression,
            node: { ...node, operand: substitute(node.operand) },
          };
    }
    case "collect": {
      const operand = node.operand;
      return {
        ...expression,
        node: {
          ...node,
          operand:
            isCollectRecordOperand(operand) ?
              {
                kind: "record",
                fields: Object.fromEntries(
                  Object.entries(operand.fields).map(([name, value]) => [
                    name,
                    substitute(value),
                  ]),
                ),
              }
            : substitute(operand),
          ...(node.filter === undefined ?
            {}
          : {
              filter: substitute(node.filter) as typeof node.filter,
            }),
          orderBy: node.orderBy.map((order) => ({
            ...order,
            expression: substitute(order.expression) as typeof order.expression,
          })),
        },
      };
    }
    case "coalesce": {
      return {
        ...expression,
        node: {
          ...node,
          operands: node.operands.map((operand) => substitute(operand)),
        },
      };
    }
    case "conditional": {
      return {
        ...expression,
        node: {
          ...node,
          condition: substitute(node.condition) as DatabaseExpression<
            boolean | undefined
          >,
          // This is AST data, never a promise-like runtime object.
          // eslint-disable-next-line unicorn/no-thenable
          then: substitute(node.then),
          otherwise: substitute(node.otherwise),
        },
      };
    }
    case "outer_reference": {
      return {
        ...expression,
        node: { ...node, expression: substitute(node.expression) },
      };
    }
    case "exists_subquery":
    case "scalar_subquery": {
      return {
        ...expression,
        node: {
          ...node,
          subquery: substituteParameters(node.subquery, bindings),
        },
      };
    }
    case "field":
    case "literal": {
      return expression;
    }
  }
}

// Own-key reads throughout this module: `bindings` is a caller-supplied
// data-keyed bag and `name` is a `param()` name, so a raw read would answer a
// parameter named after an `Object.prototype` member with the inherited member
// — defeating the missing-binding check and binding a function into the
// statement. `bindSqlValue`'s placeholder path already guards this way.
function resolveBinding(
  bindings: Readonly<Record<string, unknown>>,
  name: string,
): unknown {
  const value = readOwnProperty(bindings, name);
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
    traversals: ast.traversals.map((traversal) => {
      const variableLength = traversal.variableLength;
      if (variableLength?.stopExpansion === undefined) return traversal;
      const stopExpansion = variableLength.stopExpansion;
      return {
        ...traversal,
        variableLength: {
          ...variableLength,
          stopExpansion: {
            ...stopExpansion,
            expression: substitutePredicateExpression(
              stopExpansion.expression,
              bindings,
            ),
          },
        },
      };
    }),
    predicates: ast.predicates.map((pred) => ({
      ...pred,
      expression: substitutePredicateExpression(pred.expression, bindings),
    })),
    ...(ast.having !== undefined && {
      having: substitutePredicateExpression(ast.having, bindings),
    }),
    ...(ast.resultPredicate !== undefined && {
      resultPredicate: substitutePredicateExpression(
        ast.resultPredicate,
        bindings,
      ),
    }),
    projection: {
      ...ast.projection,
      fields: ast.projection.fields.map((projection) =>
        projection.source.__type === "database_expression" ?
          {
            ...projection,
            source: substituteDatabaseExpression(projection.source, bindings),
          }
        : projection,
      ),
    },
    ...(ast.groupBy !== undefined && {
      groupBy: {
        fields: ast.groupBy.fields.map((field) =>
          field.__type === "database_expression" ?
            substituteDatabaseExpression(field, bindings)
          : field,
        ),
      },
    }),
    ...(ast.orderBy !== undefined && {
      orderBy: ast.orderBy.map((order) => ({
        ...order,
        field:
          order.field.__type === "database_expression" ?
            substituteDatabaseExpression(order.field, bindings)
          : order.field,
      })),
    }),
  };
}

// ============================================================
// PreparedQuery
// ============================================================

type PreparedQueryConfig<R> = Readonly<{
  ast: QueryAst;
  unoptimizedAst: QueryAst;
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
 * A pre-validated, parameterized query — see the module doc comment above for
 * how a reused prepared query runs a cached SQL template with a fresh read
 * instant filled per call.
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
  readonly #backend: GraphBackend;
  readonly #dialect: SqlDialect;
  readonly #graphId: string;
  readonly #compileOptions: CompileQueryOptions;
  readonly #state: QueryBuilderState;
  readonly #selectiveFields: readonly SelectiveField[] | undefined;
  readonly #selectFn: (context: SelectContext<AliasMap, EdgeAliasMap>) => R;
  readonly #schemaIntrospector: SchemaIntrospector;
  readonly #parameterMetadata: ParameterMetadata;
  #selectiveExecutionDisabled = false;
  /**
   * Per-AST cached placeholder template, keyed by AST reference so the
   * optimized (`#ast`) and unoptimized (`#unoptimizedAst`) variants cache
   * independently. A cached `undefined` records "no fast-path template" (the
   * backend lacks `compileSql`, or the statement was not safely cacheable) so
   * we don't rebuild it on every call.
   */
  readonly #templateCache = new Map<QueryAst, CompiledTemplate | undefined>();

  constructor(config: PreparedQueryConfig<R>) {
    this.#ast = config.ast;
    this.#unoptimizedAst = config.unoptimizedAst;
    this.#backend = config.backend;
    this.#dialect = config.dialect;
    this.#graphId = config.graphId;
    this.#compileOptions = config.compileOptions;
    this.#state = config.state;
    this.#selectiveFields = config.selectiveFields;
    this.#selectFn = config.selectFn;
    this.#schemaIntrospector = config.schemaIntrospector;
    this.#parameterMetadata = collectParameterMetadata(this.#ast);
    assertDistinctParameterRoles(this.#parameterMetadata);
  }

  /**
   * The cached placeholder template for `ast`, or `undefined` when no fast
   * path applies. Compiled once (in placeholder mode) and reused across every
   * `execute()`; the read instant is refreshed per call by
   * {@link fillTemplateParams}, never frozen into the cache.
   */
  #template(ast: QueryAst): CompiledTemplate | undefined {
    if (this.#templateCache.has(ast)) return this.#templateCache.get(ast);
    const template = this.#buildTemplate(ast);
    this.#templateCache.set(ast, template);
    return template;
  }

  #buildTemplate(ast: QueryAst): CompiledTemplate | undefined {
    return buildQueryTemplate(
      ast,
      this.#graphId,
      this.#compileOptions,
      this.#backend,
    );
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

    if (
      this.#selectiveFields !== undefined &&
      !this.#selectiveExecutionDisabled
    ) {
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
        if (error instanceof MissingSelectiveFieldError) {
          // The compiled projection lacks a field the select callback can read.
          // That is a property of the callback/projection pair, not of this
          // call's bindings, so retrying the same projection on every execute
          // would permanently double the statement count.
          this.#selectiveExecutionDisabled = true;
          return this.#executeUnoptimized(bindings);
        }
        if (error instanceof UnsupportedPredicateError) {
          // This failure can depend on the bound values. Keep the optimized
          // path available for a later execution with different bindings.
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
    return this.#executeRows(this.#ast, bindings);
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
    return this.#executeRows(this.#unoptimizedAst, bindings);
  }

  /**
   * Runs one AST variant with the given bindings. Prefers the cached template
   * + `executeRaw` fast path; falls back to substituting bindings into the AST
   * and compiling fresh when the backend cannot execute raw SQL text.
   */
  async #executeRows(
    ast: QueryAst,
    bindings: Readonly<Record<string, unknown>>,
  ): Promise<readonly Record<string, unknown>[]> {
    const executeRaw = this.#backend.executeRaw;
    const template = executeRaw === undefined ? undefined : this.#template(ast);
    if (template !== undefined && executeRaw !== undefined) {
      const params = fillTemplateParams(
        template.params,
        bindings,
        this.#dialect,
        this.#parameterMetadata.listParameters,
      );
      const rawRows = await executeRaw<Record<string, unknown>>(
        template.sql,
        params,
      );
      return transformPathColumns(rawRows, this.#state, this.#dialect);
    }

    const concreteAst = substituteParameters(ast, bindings);
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

export type ParameterMetadata = Readonly<{
  names: ReadonlySet<string>;
  /** Parameters used in string_op predicates (must receive string values). */
  stringOpParameters: ReadonlySet<string>;
  /**
   * Parameters used as the whole list of `in`/`notIn`, mapped to the element
   * type their bindings must have. `undefined` means the schema declares
   * nothing usable, so no element check applies.
   */
  listParameters: ReadonlyMap<string, ValueType | undefined>;
  /** Parameters used in any position that binds a single scalar. */
  scalarParameters: ReadonlySet<string>;
  expressionParameters: ReadonlySet<string>;
  expressionParameterTypes: ReadonlyMap<string, ValueType>;
  /** Names bound in two `in`/`notIn` positions with different element types. */
  conflictingElementTypes: ReadonlySet<string>;
}>;

/** The mutable form {@link collectParameterMetadataFromAst} fills. */
type ParameterMetadataAccumulator = Readonly<{
  names: Set<string>;
  stringOpParameters: Set<string>;
  listParameters: Map<string, ValueType | undefined>;
  scalarParameters: Set<string>;
  expressionParameters: Set<string>;
  expressionParameterTypes: Map<string, ValueType>;
  /** Names bound in two `in`/`notIn` positions with different element types. */
  conflictingElementTypes: Set<string>;
}>;

export function collectParameterMetadata(
  ast: QueryAst | readonly QueryAst[],
  expressions: readonly DatabaseExpression[] = [],
): ParameterMetadata {
  const accumulator: ParameterMetadataAccumulator = {
    names: new Set<string>(),
    stringOpParameters: new Set<string>(),
    listParameters: new Map<string, ValueType | undefined>(),
    scalarParameters: new Set<string>(),
    expressionParameters: new Set<string>(),
    expressionParameterTypes: new Map<string, ValueType>(),
    conflictingElementTypes: new Set<string>(),
  };

  const queries: readonly QueryAst[] =
    Array.isArray(ast) ? ast : [ast as QueryAst];
  for (const query of queries)
    collectParameterMetadataFromAst(query, accumulator);
  for (const expression of expressions)
    collectParameterMetadataFromDatabaseExpression(expression, accumulator);

  return accumulator;
}

/**
 * A name used both as a whole list and as a scalar cannot be satisfied by one
 * binding — the same value would have to be an array in one position and a
 * scalar in the other. Called at prepare time so the query fails before its
 * first execute() rather than on whichever binding happens to arrive.
 */
function assertDistinctParameterRoles(metadata: ParameterMetadata): void {
  if (metadata.conflictingElementTypes.size > 0) {
    const names = [...metadata.conflictingElementTypes];
    throw new ConfigurationError(
      `Parameter${names.length === 1 ? "" : "s"} ${names.map((name) => `"${name}"`).join(", ")} bound as an in()/notIn() list against fields of different types; one list cannot satisfy both`,
      { conflictingParameters: names },
    );
  }

  const conflicting = [...metadata.listParameters.keys()].filter((name) =>
    metadata.scalarParameters.has(name),
  );
  if (conflicting.length === 0) return;

  throw new ConfigurationError(
    `Parameter${conflicting.length === 1 ? "" : "s"} ${conflicting.map((name) => `"${name}"`).join(", ")} used both as an in()/notIn() list and as a scalar value`,
    { conflictingParameters: conflicting },
  );
}

/**
 * Records the element type a list parameter's bindings must have.
 *
 * A name reused across two `in()` positions keeps the declared type when only
 * one side declares one; two *different* declared types are irreconcilable —
 * one array cannot be both — so the name is flagged and `prepare()` rejects it.
 */
function recordListElementType(
  accumulator: ParameterMetadataAccumulator,
  name: string,
  elementType: ValueType | undefined,
): void {
  if (!accumulator.listParameters.has(name)) {
    accumulator.listParameters.set(name, elementType);
    return;
  }
  const existing = accumulator.listParameters.get(name);
  if (existing === undefined) {
    accumulator.listParameters.set(name, elementType);
    return;
  }
  if (elementType !== undefined && elementType !== existing) {
    accumulator.conflictingElementTypes.add(name);
  }
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
  accumulator: ParameterMetadataAccumulator,
): void {
  for (const predicate of ast.predicates) {
    collectParameterMetadataFromExpression(predicate.expression, accumulator);
  }
  if (ast.resultPredicate !== undefined) {
    collectParameterMetadataFromExpression(ast.resultPredicate, accumulator);
  }
  for (const traversal of ast.traversals) {
    const stopExpression = traversal.variableLength?.stopExpansion?.expression;
    if (stopExpression !== undefined)
      collectParameterMetadataFromExpression(stopExpression, accumulator);
  }
  if (ast.having !== undefined) {
    collectParameterMetadataFromExpression(ast.having, accumulator);
  }
  for (const projection of ast.projection.fields) {
    if (projection.source.__type === "database_expression") {
      collectParameterMetadataFromDatabaseExpression(
        projection.source,
        accumulator,
      );
    }
  }
  for (const field of ast.groupBy?.fields ?? []) {
    if (field.__type === "database_expression") {
      collectParameterMetadataFromDatabaseExpression(field, accumulator);
    }
  }
  for (const order of ast.orderBy ?? []) {
    if (order.field.__type === "database_expression") {
      collectParameterMetadataFromDatabaseExpression(order.field, accumulator);
    }
  }
}

function collectParameterMetadataFromDatabaseExpression(
  expression: DatabaseExpression,
  accumulator: ParameterMetadataAccumulator,
): void {
  const node = expression.node;
  function collect(operand: DatabaseExpression): void {
    collectParameterMetadataFromDatabaseExpression(operand, accumulator);
  }
  switch (node.kind) {
    case "parameter": {
      const existingType = accumulator.expressionParameterTypes.get(node.name);
      if (existingType !== undefined && existingType !== expression.valueType)
        throw new ConfigurationError(
          `Parameter "${node.name}" is used with incompatible expression types`,
          {
            parameterName: node.name,
            expectedType: existingType,
            actualType: expression.valueType,
          },
        );
      accumulator.names.add(node.name);
      accumulator.scalarParameters.add(node.name);
      accumulator.expressionParameters.add(node.name);
      accumulator.expressionParameterTypes.set(node.name, expression.valueType);
      return;
    }
    case "arithmetic":
    case "comparison": {
      collect(node.left);
      collect(node.right);
      return;
    }
    case "boolean":
    case "coalesce": {
      for (const operand of node.operands) collect(operand);
      return;
    }
    case "not":
    case "null_check":
    case "numeric_conversion":
    case "outer_reference": {
      collect(node.kind === "outer_reference" ? node.expression : node.operand);
      return;
    }
    case "aggregate": {
      if (node.operand !== undefined) collect(node.operand);
      return;
    }
    case "collect": {
      for (const operand of collectOperandExpressions(node.operand))
        collect(operand);
      for (const order of node.orderBy) collect(order.expression);
      if (node.filter !== undefined) collect(node.filter);
      return;
    }
    case "conditional": {
      collect(node.condition);
      collect(node.then);
      collect(node.otherwise);
      return;
    }
    case "exists_subquery":
    case "scalar_subquery": {
      collectParameterMetadataFromAst(node.subquery, accumulator);
      return;
    }
    case "field":
    case "literal": {
      return;
    }
  }
}

function collectParameterMetadataFromExpression(
  expression: PredicateExpression,
  accumulator: ParameterMetadataAccumulator,
): void {
  switch (expression.__type) {
    case "comparison": {
      if (isParameterRef(expression.right)) {
        const name = expression.right.name;
        accumulator.names.add(name);
        if (isListComparisonOp(expression.op)) {
          recordListElementType(
            accumulator,
            name,
            resolveParameterValueType(expression.left, expression.right),
          );
        } else {
          accumulator.scalarParameters.add(name);
        }
      }
      return;
    }
    case "string_op": {
      if (isParameterRef(expression.pattern)) {
        accumulator.names.add(expression.pattern.name);
        accumulator.scalarParameters.add(expression.pattern.name);
        accumulator.stringOpParameters.add(expression.pattern.name);
      }
      return;
    }
    case "between": {
      for (const bound of [expression.lower, expression.upper]) {
        if (isParameterRef(bound)) {
          accumulator.names.add(bound.name);
          accumulator.scalarParameters.add(bound.name);
        }
      }
      return;
    }
    case "and":
    case "or": {
      for (const predicate of expression.predicates) {
        collectParameterMetadataFromExpression(predicate, accumulator);
      }
      return;
    }
    case "not": {
      collectParameterMetadataFromExpression(expression.predicate, accumulator);
      return;
    }
    case "database_expression_predicate": {
      collectParameterMetadataFromDatabaseExpression(
        expression.expression,
        accumulator,
      );
      return;
    }
    case "null_check":
    case "array_op":
    case "object_op":
    case "aggregate_comparison":
    case "vector_similarity":
    case "fulltext_match": {
      return;
    }
    case "exists":
    case "in_subquery": {
      collectParameterMetadataFromAst(expression.subquery, accumulator);
      return;
    }
  }
}

/** Validates and substitutes every parameter used by a query AST. */
export function bindQueryParameters(
  ast: QueryAst,
  bindings: Readonly<Record<string, unknown>>,
): QueryAst {
  const metadata = collectParameterMetadata(ast);
  assertDistinctParameterRoles(metadata);
  validateBindings(bindings, metadata);
  return substituteParameters(ast, bindings);
}

/** Validates a complete composed relation before its leaves bind their own subset. */
export function validateQueryBindings(
  queries: readonly QueryAst[],
  bindings: Readonly<Record<string, unknown>>,
  expressions: readonly DatabaseExpression[] = [],
): void {
  const metadata = collectParameterMetadata(queries, expressions);
  assertDistinctParameterRoles(metadata);
  validateBindings(bindings, metadata);
}

/** The complete relation validates its bindings before individual leaves bind their subset. */
export function bindQueryParametersSubset(
  ast: QueryAst,
  bindings: Readonly<Record<string, unknown>>,
): QueryAst {
  const names = collectParameterMetadata(ast).names;
  return bindQueryParameters(
    ast,
    Object.fromEntries(
      [...names].map((name) => [name, readOwnProperty(bindings, name)]),
    ),
  );
}

function validateBindings(
  bindings: Readonly<Record<string, unknown>>,
  metadata: ParameterMetadata,
): void {
  const {
    expressionParameters,
    expressionParameterTypes,
    names: expectedNames,
    stringOpParameters,
    listParameters,
  } = metadata;

  const missing: string[] = [];
  for (const name of expectedNames) {
    if (readOwnProperty(bindings, name) === undefined) {
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
    const value = readOwnProperty(bindings, name);
    if (listParameters.has(name)) {
      validateListBinding(name, value, listParameters.get(name));
      continue;
    }
    if (expressionParameters.has(name)) {
      normalizeDatabaseLiteral(value, `$parameter.${name}`);
      const expectedType = expressionParameterTypes.get(name);
      if (
        expectedType !== undefined &&
        expectedType !== "unknown" &&
        !matchesExpressionType(value, expectedType)
      ) {
        throw new ConfigurationError(
          `Expression parameter "${name}" must be a ${expectedType}`,
          { parameterName: name, valueType: expectedType },
        );
      }
      continue;
    }
    validateBindingValue(name, value, stringOpParameters.has(name));
  }
}

function matchesExpressionType(value: unknown, valueType: ValueType): boolean {
  if (valueType === "array") return Array.isArray(value);
  if (valueType === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  return matchesElementType(value, valueType);
}

/**
 * Validates a list-valued binding is an array of scalars of the field's type.
 *
 * The element-type check is what keeps the two backends in step. Without it
 * `[1, "a"]` against a number field passes — each element is individually a
 * legal scalar — and then PostgreSQL fails casting `"a"` to numeric while
 * SQLite's dynamic typing silently matches nothing for that element: the same
 * query, two behaviors. It also brings the parameterized form in line with the
 * literal one, which already refuses a mixed list when it compiles ("Mixed
 * literal value types are not supported in predicates") — the parameterized
 * form has no literals to inspect, so it reaches the same verdict from the
 * binding instead.
 *
 * The check rides the walk that was already validating every element, so it
 * costs a comparison per element rather than a second pass.
 */
function validateListBinding(
  name: string,
  value: unknown,
  elementType: ValueType | undefined,
): void {
  assertListBinding(name, value);
  for (const element of value) {
    validateBindingValue(name, element, false);
    if (elementType === undefined) continue;
    if (matchesElementType(element, elementType)) continue;
    throw new ConfigurationError(
      `Parameter "${name}" is bound against a ${elementType} field, so every ` +
        `element must be a ${elementType}; got ${describeBindingType(element)}`,
      { parameterName: name, valueType: elementType },
    );
  }
}

/** Whether `value` can be bound as `elementType` in an `in()`/`notIn()` list. */
function matchesElementType(value: unknown, elementType: ValueType): boolean {
  switch (elementType) {
    case "string": {
      return typeof value === "string";
    }
    case "number": {
      return typeof value === "number";
    }
    case "boolean": {
      return typeof value === "boolean";
    }
    case "date": {
      // Either a Date or the ISO text TypeGraph stores. Arbitrary strings are
      // not parsed here: the literal form does not validate them either, and
      // guessing which formats PostgreSQL accepts would reject valid input.
      return value instanceof Date || typeof value === "string";
    }
    // No element cast is emitted for these, so there is no divergence to
    // prevent — `array`/`object` are rejected earlier, at compile time.
    case "array":
    case "object":
    case "embedding":
    case "unknown": {
      return true;
    }
  }
}

/** A binding's type as it should read in an error message. */
function describeBindingType(value: unknown): string {
  if (value instanceof Date) return "date";
  return typeof value;
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
  if (typeof value === "number") {
    // JSON.stringify turns NaN and +/-Infinity into `null`, which the packed
    // list form would bind as SQL NULL — silently poisoning the predicate
    // (`NOT IN (NULL)` matches no row at all). The scalar form is no better:
    // SQLite stores a bound NaN as NULL, so `eq(NaN)` quietly matches nothing.
    // Neither is a value any comparison can mean, so reject both shapes here.
    if (!Number.isFinite(value)) {
      throw new ConfigurationError(
        `Parameter "${name}" must be a finite number, got ${String(value)}`,
        { parameterName: name, actualType: "number" },
      );
    }
    return;
  }
  if (
    value instanceof Date ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  throw new ConfigurationError(
    `Unsupported parameter value type: ${typeof value}`,
    { parameterName: name, actualType: typeof value },
  );
}
