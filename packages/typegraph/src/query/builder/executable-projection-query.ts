import { backendDerivationRoot } from "../../backend/derive-backend";
import type { GraphBackend, TransactionBackend } from "../../backend/types";
import { ConfigurationError } from "../../errors";
import { withRecordedRelationsPrecondition } from "../../utils/sql-errors";
import type { QueryAst, SortDirection, ValueType } from "../ast";
import { compileQuery } from "../compiler";
import { executeSchemaCheckedRead } from "../execution/schema-checked-read";
import type { DatabaseExpression } from "../expressions";
import { compileOrderTerm, resolveNullOrdering } from "../order";
import { sql } from "../sql-fragment";
import { asCompiledSelectSql } from "../sql-intent";
import { buildQueryAst } from "./ast-builder";
import { buildCompileOptions } from "./compile-options";
import { assertExpressionScope, getExpressionScope } from "./expression-scope";
import type { ExpressionProjectionEntries } from "./expression-subqueries";
import { getQueryBuilderInternalContext } from "./internal-context";
import { bindQueryParameters, hasParameterReferences } from "./prepared-query";
import {
  createProjectionRelation,
  type ExecutableRelationQuery,
} from "./relation";
import { renderQuerySql } from "./render-query-sql";
import type { QueryBuilderConfig, QueryBuilderState } from "./types";
import { validateQueryRange, validateSortDirection } from "./validation";

export type DatabaseProjection = Readonly<Record<string, DatabaseExpression>>;
export type ProjectionResult<Fields extends DatabaseProjection> = {
  -readonly [Key in keyof Fields]: Fields[Key] extends (
    DatabaseExpression<infer Value>
  ) ?
    Value
  : never;
};

/** Explicit SQL results: construction never executes a JavaScript row selector. */
export class ExecutableProjectionQuery<
  Fields extends DatabaseProjection,
  Context,
  Result = ProjectionResult<Fields>,
> {
  readonly #config: QueryBuilderConfig;
  readonly #state: QueryBuilderState;
  readonly #fields: Fields;
  readonly #context: () => Context;
  readonly #mapper: ((row: ProjectionResult<Fields>) => Result) | undefined;

  constructor(
    config: QueryBuilderConfig,
    state: QueryBuilderState,
    fields: Fields,
    context: () => Context,
    mapper?: (row: ProjectionResult<Fields>) => Result,
  ) {
    this.#config = config;
    this.#state = state;
    this.#fields = fields;
    this.#context = context;
    this.#mapper = mapper;
  }

  #copy(
    state: QueryBuilderState,
  ): ExecutableProjectionQuery<Fields, Context, Result> {
    return new ExecutableProjectionQuery(
      this.#config,
      state,
      this.#fields,
      this.#context,
      this.#mapper,
    );
  }

  limit(value: number): ExecutableProjectionQuery<Fields, Context, Result> {
    validateQueryRange(value, "limit");
    return this.#copy({ ...this.#state, limit: value });
  }

  offset(value: number): ExecutableProjectionQuery<Fields, Context, Result> {
    validateQueryRange(value, "offset");
    return this.#copy({ ...this.#state, offset: value });
  }

  orderBy(
    build: (context: Context) => DatabaseExpression,
    direction: SortDirection = "asc",
  ): ExecutableProjectionQuery<Fields, Context, Result> {
    validateSortDirection(direction);
    const expression = build(this.#context());
    assertExpressionScope(expression, this.getExpressionScopeIdentity());
    return this.#copy({
      ...this.#state,
      orderBy: [...this.#state.orderBy, { field: expression, direction }],
    });
  }

  map<Mapped>(
    mapper: (row: Result) => Mapped,
  ): ExecutableProjectionQuery<Fields, Context, Mapped> {
    return new ExecutableProjectionQuery(
      this.#config,
      this.#state,
      this.#fields,
      this.#context,
      (row) => mapper(this.#mapRow(row)),
    );
  }

  toAst(): QueryAst {
    return buildQueryAst(this.#config, this.#state);
  }
  getExpressionScopeIdentity(): symbol {
    return getExpressionScope(this.#config);
  }
  getOneStatementReadProvenance() {
    return {
      graphId: this.#config.graphId,
      executionTarget:
        this.#config.backend === undefined ?
          undefined
        : backendDerivationRoot(this.#config.backend),
    };
  }
  getExpressionProjection(): ExpressionProjectionEntries<Fields> {
    if (this.#mapper !== undefined)
      throw new ConfigurationError(
        "Subqueries consume SQL projections; apply map() after the enclosing query executes.",
      );
    return Object.entries(this.#fields).map(([outputName, expression]) => ({
      outputName,
      expression,
    })) as unknown as ExpressionProjectionEntries<Fields>;
  }

  /** Enters the shared relational composition surface for derived queries and set operations. */
  asRelation(): ExecutableRelationQuery<Fields, Result> {
    return createProjectionRelation({
      config: this.#config,
      ast: this.toAst(),
      fields: this.#fields,
      checked:
        getQueryBuilderInternalContext(this.#config).expectedSchemaVersion !==
        undefined,
      mapped: this.#mapper !== undefined,
      decodeRow: (row) => this.#decodeRow(row),
    });
  }

  compile() {
    return compileQuery(
      this.toAst(),
      this.#config.graphId,
      buildCompileOptions(this.#config),
    );
  }
  toSQL(): Readonly<{ sql: string; params: readonly unknown[] }> {
    return renderQuerySql(this.#requireBackend(), () => this.compile());
  }

  execute(): Promise<readonly Result[]> {
    return this.executeOn(this.#requireBackend());
  }
  /** Runs on an explicitly supplied target, including store.batch() transactions. */
  async executeOn(
    backend: GraphBackend | TransactionBackend,
  ): Promise<readonly Result[]> {
    const rows = await this.#fetchRows(backend, this.toAst());
    return rows.map((row) => this.#decodeRow(row));
  }
  async first(): Promise<Result | undefined> {
    const rows = await this.limit(
      Math.min(this.#state.limit ?? 1, 1),
    ).execute();
    return rows[0];
  }
  count(): Promise<number> {
    return this.#scalarTerminal("count");
  }
  async exists(): Promise<boolean> {
    return (await this.#scalarTerminal("exists")) > 0;
  }

  prepare(): Readonly<{
    execute: (
      bindings: Readonly<Record<string, unknown>>,
    ) => Promise<readonly Result[]>;
  }> {
    const ast = this.toAst();
    const backend = this.#requireBackend();
    return {
      execute: async (bindings) => {
        const bound = bindQueryParameters(ast, bindings);
        const rows = await this.#fetchRows(backend, bound);
        return rows.map((row) => this.#decodeRow(row));
      },
    };
  }

  compileOneStatementBatchItem() {
    const backend = this.#requireBackend();
    if (
      getQueryBuilderInternalContext(this.#config).expectedSchemaVersion !==
      undefined
    )
      throw new ConfigurationError(
        "Checked projections cannot be embedded in batchOnce().",
      );
    if (this.#state.recordedAsOf !== undefined)
      throw new ConfigurationError(
        "Recorded projections cannot be embedded in batchOnce().",
      );
    const ast = this.toAst();
    this.#assertBound(ast);
    const { ast: envelope, orderBy } = buildProjectionEnvelope(ast);
    return {
      query: compileQuery(
        envelope,
        this.#config.graphId,
        buildCompileOptions(this.#config),
      ),
      provenance: {
        graphId: this.#config.graphId,
        executionTarget: backendDerivationRoot(backend),
      },
      outputNames: envelope.projection.fields.map((field) => field.outputName),
      orderBy,
      mapRows: (rows: readonly Record<string, unknown>[]) =>
        rows.map((row) => this.#decodeRow(row)),
    };
  }

  #requireBackend(): GraphBackend | TransactionBackend {
    if (this.#config.backend === undefined)
      throw new ConfigurationError(
        "Projection execution requires a backend; use store.query().",
      );
    return this.#config.backend;
  }
  #assertBound(ast: QueryAst): void {
    if (hasParameterReferences(ast))
      throw new ConfigurationError(
        "Projection contains unbound parameters; use prepare().execute(bindings).",
      );
  }
  #recorded<T>(
    operation: Promise<T>,
    backend = this.#requireBackend(),
  ): Promise<T> {
    return this.#state.recordedAsOf === undefined ?
        operation
      : withRecordedRelationsPrecondition(operation, {
          dialect: backend.dialect,
          surface: "recorded-projection",
        });
  }
  #fetchRows(
    backend: GraphBackend | TransactionBackend,
    ast: QueryAst,
  ): Promise<readonly Record<string, unknown>[]> {
    this.#assertBound(ast);
    const checked = getQueryBuilderInternalContext(
      this.#config,
    ).expectedSchemaVersion;
    const compiled = compileQuery(
      ast,
      this.#config.graphId,
      buildCompileOptions(this.#config),
    );
    if (checked === undefined)
      return this.#recorded(
        backend.execute<Record<string, unknown>>(compiled),
        backend,
      );
    const { ast: envelope, orderBy } = buildProjectionEnvelope(ast);
    const ordered =
      orderBy.length === 0 ?
        compiled
      : compileQuery(
          envelope,
          this.#config.graphId,
          buildCompileOptions(this.#config),
        );
    const resultOrderBy =
      orderBy.length === 0 ?
        sql.empty()
      : sql`ORDER BY ${sql.join(
          orderBy.map((order) =>
            compileOrderTerm(
              sql`${sql.identifier("checked_rows")}.${sql.identifier(order.column)}`,
              order.direction,
              order.nulls,
            ),
          ),
          sql`, `,
        )}`;
    return this.#recorded(
      executeSchemaCheckedRead({
        backend,
        ast,
        graphId: this.#config.graphId,
        expectedVersion: checked.value,
        resultOrderBy,
        rowIdentityColumn: "__tg_projection_row",
        compile: () =>
          asCompiledSelectSql(
            sql`SELECT projected.*, 1 AS __tg_projection_row FROM (${ordered}) AS projected`,
          ),
      }),
      backend,
    );
  }
  async #scalarTerminal(operation: "count" | "exists"): Promise<number> {
    const ast = this.toAst();
    this.#assertBound(ast);
    const relation = compileQuery(
      ast,
      this.#config.graphId,
      buildCompileOptions(this.#config),
    );
    const compiled = asCompiledSelectSql(
      operation === "count" ?
        sql`SELECT COUNT(*) AS __tg_scalar FROM (${relation}) AS projected`
      : sql`SELECT CASE WHEN EXISTS (${relation}) THEN 1 ELSE 0 END AS __tg_scalar`,
    );
    const backend = this.#requireBackend();
    const checked = getQueryBuilderInternalContext(
      this.#config,
    ).expectedSchemaVersion;
    const { orderBy: _orderBy, ...unordered } = ast;
    const rows = await this.#recorded(
      checked === undefined ?
        backend.execute<Record<string, unknown>>(compiled)
      : executeSchemaCheckedRead({
          backend,
          ast: unordered,
          graphId: this.#config.graphId,
          expectedVersion: checked.value,
          rowIdentityColumn: "__tg_scalar",
          compile: () => compiled,
        }),
    );
    return Number(rows[0]?.["__tg_scalar"] ?? 0);
  }
  #decodeRow(row: Record<string, unknown>): Result {
    const decoded = Object.fromEntries(
      Object.entries(this.#fields).map(([key, expression]) => [
        key,
        decodeExpressionValue(row[key], expression),
      ]),
    ) as ProjectionResult<Fields>;
    return this.#mapRow(decoded);
  }
  #mapRow(row: ProjectionResult<Fields>): Result {
    return this.#mapper === undefined ?
        (row as unknown as Result)
      : this.#mapper(row);
  }
}

export function decodeExpressionValue(
  value: unknown,
  expression: DatabaseExpression,
): unknown {
  if (value === null || value === undefined) return undefined;
  switch (expression.valueType) {
    case "boolean":
    case "date":
    case "number":
    case "string": {
      return decodeScalarExpressionValue(value, expression.valueType);
    }
    case "object":
    case "embedding": {
      return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
    }
    case "array": {
      const parsed =
        typeof value === "string" ? (JSON.parse(value) as unknown) : value;
      if (!Array.isArray(parsed) || expression.elementValueType === undefined)
        return parsed;
      const elementValueType = expression.elementValueType;
      const elementFields = expression.elementFields;
      return parsed.map((element) => {
        if (element === null || element === undefined) return;
        return elementFields === undefined ?
            decodeScalarExpressionValue(element, elementValueType)
          : decodeRecordExpressionValue(element, elementFields);
      });
    }
    case "unknown": {
      return value;
    }
  }
}

/** Decode only the explicitly projected scalar fields, preserving records whose fields are all null. */
function decodeRecordExpressionValue(
  value: unknown,
  fields: Readonly<Record<string, ValueType>>,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ConfigurationError(
      "Expected a JSON object in a record collection.",
    );
  const record = value as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.entries(fields).map(([key, valueType]) => {
      const field = record[key];
      return [
        key,
        field === null || field === undefined ?
          undefined
        : decodeScalarExpressionValue(field, valueType),
      ];
    }),
  );
}

function decodeScalarExpressionValue(
  value: unknown,
  valueType: ValueType,
): unknown {
  switch (valueType) {
    case "boolean": {
      return value === true || value === 1 || value === "true" || value === "1";
    }
    case "number": {
      return Number(value);
    }
    case "date": {
      return (
        value instanceof Date ? value
        : typeof value === "string" || typeof value === "number" ?
          new Date(value)
        : value
      );
    }
    case "string": {
      return value;
    }
    case "array":
    case "embedding":
    case "object":
    case "unknown": {
      return value;
    }
  }
}

/** Carries sort values through SQL envelopes without exposing them in decoded results. */
function buildProjectionEnvelope(ast: QueryAst) {
  const ordering = ast.orderBy ?? [];
  const orderBy = ordering.map((order, index) => ({
    column: `__tg_order_${index}`,
    direction: order.direction,
    nulls: resolveNullOrdering(order),
  }));
  return {
    ast: {
      ...ast,
      projection: {
        ...ast.projection,
        fields: [
          ...ast.projection.fields,
          ...ordering.map((order, index) => ({
            outputName: `__tg_order_${index}`,
            source: order.field,
          })),
        ],
      },
    },
    orderBy,
  };
}
