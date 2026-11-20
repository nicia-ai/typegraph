import { backendDerivationRoot } from "../../backend/derive-backend";
import type { GraphBackend, TransactionBackend } from "../../backend/types";
import {
  ConfigurationError,
  UnsupportedBackendCapabilityError,
} from "../../errors";
import { withRecordedRelationsPrecondition } from "../../utils/sql-errors";
import { isPortableCountDistinctValueType } from "../aggregate-value-types";
import type { QueryAst, SortDirection } from "../ast";
import {
  assertCompatibleRelationColumns,
  compileRelation,
  type RelationAst,
  type RelationColumn,
  type RelationOrder,
  type TopPerPartitionRelation,
} from "../compiler/relations";
import { getDialect } from "../dialect";
import {
  createFieldExpression,
  type DatabaseExpression,
  expr,
} from "../expressions";
import { resolveNullOrdering } from "../order";
import { sql } from "../sql-fragment";
import { asCompiledSelectSql } from "../sql-intent";
import { buildCompileOptions } from "./compile-options";
import { decodeExpressionValue } from "./executable-projection-query";
import {
  assertExpressionScope,
  isDatabaseExpression,
} from "./expression-scope";
import {
  type PreparedBindings,
  type PreparedParameterDeclaration,
  validatePreparedBindingsDeclaration,
} from "./prepared-bindings";
import {
  bindQueryParametersSubset,
  collectParameterMetadata,
  substituteDatabaseExpression,
  validateQueryBindings,
} from "./prepared-query";
import {
  buildReadInstantTemplate,
  type CompiledTemplate,
  fillTemplateParams,
} from "./read-instant-template";
import { renderQuerySql } from "./render-query-sql";
import type { QueryBuilderConfig } from "./types";
import { validateQueryRange, validateSortDirection } from "./validation";

export type RelationProjection = Readonly<Record<string, DatabaseExpression>>;
export type RelationProjectionResult<Fields extends RelationProjection> = {
  -readonly [Key in keyof Fields]: Fields[Key] extends (
    DatabaseExpression<infer Value>
  ) ?
    Value
  : never;
};

export type RelationColumnContext<Fields extends RelationProjection> = {
  readonly [Key in keyof Fields]: Fields[Key] extends (
    DatabaseExpression<infer Value, infer Scope>
  ) ?
    DatabaseExpression<Value, Scope>
  : never;
};

/**
 * A scalar ordering term used to choose winners within each partition.
 * Defaults to ascending with NULLS LAST; descending defaults to NULLS FIRST.
 * @public
 */
export type TopPerPartitionOrder = Readonly<{
  expression: DatabaseExpression;
  direction?: SortDirection;
  nulls?: "first" | "last";
}>;

/**
 * Selects up to `limit` rows per partition using explicit scalar keys and ordering.
 * Include a stable final tie-breaker; tied rows do not expand the positive safe-integer limit.
 * @public
 */
export type TopPerPartitionOptions<Fields extends RelationProjection> =
  Readonly<{
    partitionBy: (
      columns: RelationColumnContext<Fields>,
    ) => readonly [DatabaseExpression, ...DatabaseExpression[]];
    orderBy: (
      columns: RelationColumnContext<Fields>,
    ) => readonly [TopPerPartitionOrder, ...TopPerPartitionOrder[]];
    limit: number;
  }>;

export type RelationProvenance = Readonly<{
  graphId: string;
  executionTarget: object | undefined;
  recordedAsOf: string | undefined;
  checked: boolean;
  temporalCoordinate: string;
}>;

export type RelationDefinition<
  Fields extends RelationProjection,
  Result,
> = Readonly<{
  ast: RelationAst;
  columns: readonly RelationColumn[];
  fields: Fields;
  config: QueryBuilderConfig;
  provenance: RelationProvenance;
  decodeRow: (row: Record<string, unknown>) => Result;
  mapped?: boolean;
}>;

type RelationState = Readonly<{
  predicate?: DatabaseExpression<boolean | undefined>;
  groupBy?: readonly DatabaseExpression[];
  distinct: boolean;
  orderBy: readonly RelationOrder[];
  limit?: number;
  offset?: number;
}>;

const EMPTY_STATE: RelationState = { distinct: false, orderBy: [] };

/** Sentinel distinguishing a template that was not built from one that cannot be built. */
const NOT_COMPUTED = Symbol("NOT_COMPUTED");

function relationScope(): symbol {
  return Symbol("derived relation expression scope");
}

function outputField(
  outputName: string,
  valueType: RelationColumn["valueType"],
) {
  return {
    __type: "field_ref",
    alias: "relation",
    path: [outputName],
    valueType,
  } as const;
}

function buildContext<Fields extends RelationProjection>(
  columns: readonly RelationColumn[],
  scopeIdentity: symbol,
): RelationColumnContext<Fields> {
  return Object.fromEntries(
    columns.map((column) => [
      column.outputName,
      {
        ...createFieldExpression(
          outputField(column.outputName, column.valueType),
          scopeIdentity,
          column.nullable,
        ),
        ...(column.elementValueType === undefined ?
          {}
        : { elementValueType: column.elementValueType }),
        ...(column.elementFields === undefined ?
          {}
        : { elementFields: column.elementFields }),
      },
    ]),
  ) as RelationColumnContext<Fields>;
}

function relationColumns(
  fields: RelationProjection,
  options: Readonly<{
    sourceColumns?: readonly RelationColumn[];
    nodeAliases?: ReadonlySet<string>;
  }> = {},
): readonly RelationColumn[] {
  return Object.entries(fields).map(([outputName, expression]) => {
    const base = {
      outputName,
      valueType: expression.valueType,
      ...(expression.elementValueType === undefined ?
        {}
      : { elementValueType: expression.elementValueType }),
      ...(expression.elementFields === undefined ?
        {}
      : { elementFields: expression.elementFields }),
      nullable: expression.nullable,
    };
    if (
      expression.node.kind !== "field" ||
      expression.node.field.path.length !== 1
    )
      return base;
    const field = expression.node.field;
    if (field.alias === "relation") {
      const identity = options.sourceColumns?.find(
        (column) => column.outputName === field.path[0],
      )?.identity;
      return identity === undefined ? base : { ...base, identity };
    }
    if (
      options.nodeAliases?.has(field.alias) === true &&
      (field.path[0] === "id" || field.path[0] === "kind")
    )
      return {
        ...base,
        identity: { alias: field.alias, component: field.path[0] },
      };
    return base;
  });
}

function assertCompatibleProvenance(
  left: RelationProvenance,
  right: RelationProvenance,
): void {
  if (
    left.graphId !== right.graphId ||
    left.executionTarget !== right.executionTarget ||
    left.recordedAsOf !== right.recordedAsOf ||
    left.checked !== right.checked ||
    left.temporalCoordinate !== right.temporalCoordinate
  ) {
    throw new ConfigurationError(
      "Relations can compose only when graph, execution target, temporal coordinate, and checked-read state match.",
    );
  }
}

function relationQueries(relation: RelationAst): readonly QueryAst[] {
  switch (relation.kind) {
    case "source": {
      return [relation.query];
    }
    case "set": {
      return [
        ...relationQueries(relation.left),
        ...relationQueries(relation.right),
      ];
    }
    case "derived": {
      return relationQueries(relation.source);
    }
    case "topPerPartition": {
      return relationQueries(relation.source);
    }
  }
}

function relationHasTopPerPartition(relation: RelationAst): boolean {
  switch (relation.kind) {
    case "source": {
      return false;
    }
    case "derived": {
      return relationHasTopPerPartition(relation.source);
    }
    case "set": {
      return (
        relationHasTopPerPartition(relation.left) ||
        relationHasTopPerPartition(relation.right)
      );
    }
    case "topPerPartition": {
      return true;
    }
  }
}

function relationExpressions(
  relation: RelationAst,
): readonly DatabaseExpression[] {
  switch (relation.kind) {
    case "source": {
      return [];
    }
    case "set": {
      return [
        ...relationExpressions(relation.left),
        ...relationExpressions(relation.right),
      ];
    }
    case "derived": {
      return [
        ...relationExpressions(relation.source),
        ...relation.projection.map(({ expression }) => expression),
        ...(relation.predicate === undefined ? [] : [relation.predicate]),
        ...(relation.groupBy ?? []),
        ...relation.orderBy.map(({ expression }) => expression),
      ];
    }
    case "topPerPartition": {
      return [
        ...relationExpressions(relation.source),
        ...relation.partitionBy,
        ...relation.orderBy.map(({ expression }) => expression),
      ];
    }
  }
}

function bindRelation(
  relation: RelationAst,
  bindings: Readonly<Record<string, unknown>>,
): RelationAst {
  switch (relation.kind) {
    case "source": {
      return {
        ...relation,
        query: bindQueryParametersSubset(relation.query, bindings),
      };
    }
    case "set": {
      return {
        ...relation,
        left: bindRelation(relation.left, bindings),
        right: bindRelation(relation.right, bindings),
      };
    }
    case "derived": {
      return {
        ...relation,
        source: bindRelation(relation.source, bindings),
        projection: relation.projection.map(({ column, expression }) => ({
          column,
          expression: substituteDatabaseExpression(expression, bindings),
        })),
        ...(relation.predicate === undefined ?
          {}
        : {
            predicate: substituteDatabaseExpression(
              relation.predicate,
              bindings,
            ),
          }),
        ...(relation.groupBy === undefined ?
          {}
        : {
            groupBy: relation.groupBy.map((expression) =>
              substituteDatabaseExpression(expression, bindings),
            ),
          }),
        orderBy: relation.orderBy.map((order) => ({
          ...order,
          expression: substituteDatabaseExpression(order.expression, bindings),
        })),
      };
    }
    case "topPerPartition": {
      return {
        ...relation,
        source: bindRelation(relation.source, bindings),
        partitionBy: relation.partitionBy.map((expression) =>
          substituteDatabaseExpression(expression, bindings),
        ),
        orderBy: relation.orderBy.map((order) => ({
          ...order,
          expression: substituteDatabaseExpression(order.expression, bindings),
        })),
      };
    }
  }
}

function bindState(
  state: RelationState,
  bindings: Readonly<Record<string, unknown>>,
): RelationState {
  return {
    ...state,
    ...(state.predicate === undefined ?
      {}
    : { predicate: substituteDatabaseExpression(state.predicate, bindings) }),
    ...(state.groupBy === undefined ?
      {}
    : {
        groupBy: state.groupBy.map((expression) =>
          substituteDatabaseExpression(expression, bindings),
        ),
      }),
    orderBy: state.orderBy.map((order) => ({
      ...order,
      expression: substituteDatabaseExpression(order.expression, bindings),
    })),
  };
}

/** Rewrites every source to emit its live read instant as a reusable placeholder. */
function withPlaceholderReadInstants(relation: RelationAst): RelationAst {
  switch (relation.kind) {
    case "source": {
      return {
        ...relation,
        options: { ...relation.options, readInstant: "placeholder" },
      };
    }
    case "set": {
      return {
        ...relation,
        left: withPlaceholderReadInstants(relation.left),
        right: withPlaceholderReadInstants(relation.right),
      };
    }
    case "derived": {
      return {
        ...relation,
        source: withPlaceholderReadInstants(relation.source),
      };
    }
    case "topPerPartition": {
      return {
        ...relation,
        source: withPlaceholderReadInstants(relation.source),
      };
    }
  }
}

/** Whether a relation contains a live source whose valid-time instant must remain fresh. */
function relationNeedsCurrentReadInstant(relation: RelationAst): boolean {
  return relationQueries(relation).some(
    (query) =>
      query.temporalMode.mode === "current" && query.recordedAsOf === undefined,
  );
}

function assertPortableDistinctColumns(
  columns: readonly RelationColumn[],
  operation: string,
): void {
  const unsupported = columns.find(
    (column) => !isPortableCountDistinctValueType(column.valueType),
  );
  if (unsupported !== undefined)
    throw new ConfigurationError(
      `${operation} requires portable scalar projected columns; "${unsupported.outputName}" has type ${unsupported.valueType}.`,
    );
}

function assertPartitionScalarKey(
  value: unknown,
  scopeIdentity: symbol,
  role: "partition" | "ordering",
): asserts value is DatabaseExpression {
  if (!isDatabaseExpression(value))
    throw new ConfigurationError(
      `topPerPartition() requires expression ${role} keys.`,
    );
  assertExpressionScope(value, scopeIdentity);
  if (
    !isPortableCountDistinctValueType(value.valueType) ||
    value.elementValueType !== undefined
  )
    throw new ConfigurationError(
      `topPerPartition() requires scalar ${role} keys.`,
    );
}

function mergedSetColumns(
  left: readonly RelationColumn[],
  right: readonly RelationColumn[],
): readonly RelationColumn[] {
  const leftAliases = new Set(
    left.flatMap((column) =>
      column.identity === undefined ? [] : [column.identity.alias],
    ),
  );
  const rightAliases = new Set(
    right.flatMap((column) =>
      column.identity === undefined ? [] : [column.identity.alias],
    ),
  );
  const preservesIdentity =
    leftAliases.size === 1 &&
    rightAliases.size === 1 &&
    left.every(
      (column, index) =>
        column.identity?.component === right[index]?.identity?.component,
    );
  if (preservesIdentity) return left;
  return left.map(({ identity: _identity, ...column }) => column);
}

export class ExecutableRelationQuery<
  Fields extends RelationProjection,
  Result = RelationProjectionResult<Fields>,
> {
  readonly #definition: RelationDefinition<Fields, Result>;
  readonly #scopeIdentity: symbol;
  readonly #state: RelationState;
  readonly #context: RelationColumnContext<Fields>;
  #template: CompiledTemplate | undefined | typeof NOT_COMPUTED = NOT_COMPUTED;
  readonly #scalarTemplates = new Map<
    "count" | "exists",
    CompiledTemplate | undefined
  >();

  constructor(
    definition: RelationDefinition<Fields, Result>,
    state: RelationState = EMPTY_STATE,
    scopeIdentity = relationScope(),
  ) {
    this.#definition = definition;
    this.#state = state;
    this.#scopeIdentity = scopeIdentity;
    this.#context = buildContext<Fields>(definition.columns, scopeIdentity);
  }

  #copy(state: RelationState): ExecutableRelationQuery<Fields, Result> {
    return new ExecutableRelationQuery(
      this.#definition,
      state,
      this.#scopeIdentity,
    );
  }

  #materialize(): RelationAst {
    const projection = [
      ...this.#definition.columns.map((column) => ({
        column,
        expression: this.#context[column.outputName as keyof Fields],
      })),
      ...this.#state.orderBy.map((order, index) => ({
        column: {
          outputName: `__tg_relation_order_${index}`,
          valueType: order.expression.valueType,
          nullable: order.expression.nullable,
        },
        expression: order.expression,
      })),
    ];
    return {
      kind: "derived",
      source: this.#definition.ast,
      sourceColumns: this.#definition.columns,
      projection,
      distinct: this.#state.distinct,
      orderBy: this.#state.orderBy,
      ...(this.#state.predicate === undefined ?
        {}
      : { predicate: this.#state.predicate }),
      ...(this.#state.groupBy === undefined ?
        {}
      : { groupBy: this.#state.groupBy }),
      ...(this.#state.limit === undefined ? {} : { limit: this.#state.limit }),
      ...(this.#state.offset === undefined ?
        {}
      : { offset: this.#state.offset }),
    };
  }

  /** Captures completed SQL stages for composition without exposing execution provenance. */
  #materializedDefinition(): RelationDefinition<Fields, Result> {
    return { ...this.#definition, ast: this.#materialize() };
  }

  where(
    build: (
      columns: RelationColumnContext<Fields>,
    ) => DatabaseExpression<boolean | undefined>,
  ): ExecutableRelationQuery<Fields, Result> {
    const predicate = build(this.#context);
    assertExpressionScope(predicate, this.#scopeIdentity);
    if (predicate.valueType !== "boolean")
      throw new ConfigurationError(
        "Relation filters require a Boolean expression.",
      );
    const combined =
      this.#state.predicate === undefined ?
        predicate
      : expr.and(this.#state.predicate, predicate);
    return this.#copy({ ...this.#state, predicate: combined });
  }

  groupBy(
    build: (
      columns: RelationColumnContext<Fields>,
    ) => readonly DatabaseExpression[],
  ): ExecutableRelationQuery<Fields, Result> {
    const groupBy = build(this.#context);
    if (groupBy.length === 0)
      throw new ConfigurationError(
        "groupBy() requires at least one expression.",
      );
    for (const expression of groupBy)
      assertExpressionScope(expression, this.#scopeIdentity);
    return this.#copy({
      ...this.#state,
      groupBy: [...(this.#state.groupBy ?? []), ...groupBy],
    });
  }

  project<const NextFields extends RelationProjection>(
    build: (columns: RelationColumnContext<Fields>) => NextFields,
  ): ExecutableRelationQuery<NextFields> {
    return this.#project(build(this.#context));
  }

  aggregate<const NextFields extends RelationProjection>(
    build: (columns: RelationColumnContext<Fields>) => NextFields,
  ): ExecutableRelationQuery<NextFields> {
    return this.#project(build(this.#context));
  }

  #project<NextFields extends RelationProjection>(
    fields: NextFields,
  ): ExecutableRelationQuery<NextFields> {
    if (this.#definition.mapped === true)
      throw new ConfigurationError(
        "A post-execution mapped relation cannot be projected or aggregated again.",
      );
    const entries = Object.entries(fields);
    if (entries.length === 0)
      throw new ConfigurationError(
        "A relation projection requires at least one expression.",
      );
    for (const [, expression] of entries)
      assertExpressionScope(expression, this.#scopeIdentity);
    // Grouping belongs to the new projection; all other modifiers describe its input rows.
    const { groupBy: grouping, ...inputState } = this.#state;
    const source = this.#copy(inputState).#materialize();
    const columns = relationColumns(fields, {
      sourceColumns: this.#definition.columns,
    });
    const ast: RelationAst = {
      kind: "derived",
      source,
      sourceColumns: this.#definition.columns,
      projection: columns.map((column, index) => {
        const expression = entries[index]?.[1];
        if (expression === undefined)
          throw new ConfigurationError(
            "Relation projection metadata is incomplete.",
          );
        return { column, expression };
      }),
      distinct: false,
      orderBy: [],
      ...(grouping === undefined ? {} : { groupBy: grouping }),
    };
    return createExecutableRelation({
      ast,
      columns,
      fields,
      config: this.#definition.config,
      provenance: this.#definition.provenance,
      decodeRow: (row) =>
        Object.fromEntries(
          entries.map(([outputName, expression]) => [
            outputName,
            decodeExpressionValue(row[outputName], expression),
          ]),
        ) as RelationProjectionResult<NextFields>,
    });
  }

  orderBy(
    build: (columns: RelationColumnContext<Fields>) => DatabaseExpression,
    direction: SortDirection = "asc",
    nulls: "first" | "last" = direction === "asc" ? "last" : "first",
  ): ExecutableRelationQuery<Fields, Result> {
    validateSortDirection(direction);
    const expression = build(this.#context);
    assertExpressionScope(expression, this.#scopeIdentity);
    return this.#copy({
      ...this.#state,
      orderBy: [...this.#state.orderBy, { expression, direction, nulls }],
    });
  }

  /**
   * Selects up to N rows per partition after applying current input modifiers.
   * Later filters remove winners without replacement. Add ordering after this stage
   * to control result order. Requires backend window-function support.
   * @public
   */
  topPerPartition(
    options: TopPerPartitionOptions<Fields>,
  ): ExecutableRelationQuery<Fields, Result> {
    const runtimeOptions: unknown = options;
    if (
      runtimeOptions === undefined ||
      runtimeOptions === null ||
      typeof runtimeOptions !== "object" ||
      Object.keys(options).some(
        (key) => key !== "partitionBy" && key !== "orderBy" && key !== "limit",
      ) ||
      typeof options.partitionBy !== "function" ||
      typeof options.orderBy !== "function"
    )
      throw new ConfigurationError(
        "topPerPartition() requires partitionBy, orderBy, and limit options only.",
      );
    if (!Number.isSafeInteger(options.limit) || options.limit <= 0)
      throw new ConfigurationError(
        "topPerPartition() limit must be a positive safe integer.",
      );
    if (this.#definition.mapped === true || this.#state.groupBy !== undefined)
      throw new ConfigurationError(
        "topPerPartition() cannot rank a post-execution mapped relation or pending groupBy().",
      );
    const partitionBy = options.partitionBy(this.#context);
    const requestedOrders = options.orderBy(this.#context);
    if (
      !Array.isArray(partitionBy) ||
      partitionBy.length === 0 ||
      !Array.isArray(requestedOrders) ||
      requestedOrders.length === 0
    )
      throw new ConfigurationError(
        "topPerPartition() requires nonempty partition and ordering keys.",
      );
    for (const expression of partitionBy) {
      assertPartitionScalarKey(expression, this.#scopeIdentity, "partition");
    }
    const orderBy = requestedOrders.map((order) => {
      const runtimeOrder: unknown = order;
      if (
        runtimeOrder === undefined ||
        runtimeOrder === null ||
        typeof runtimeOrder !== "object" ||
        Object.keys(order).some(
          (key) =>
            key !== "expression" && key !== "direction" && key !== "nulls",
        )
      )
        throw new ConfigurationError(
          "topPerPartition() has an invalid ordering option.",
        );
      const { expression, direction = "asc", nulls } = order;
      assertPartitionScalarKey(expression, this.#scopeIdentity, "ordering");
      validateSortDirection(direction);
      const runtimeNulls: unknown = nulls;
      if (
        runtimeNulls !== undefined &&
        runtimeNulls !== "first" &&
        runtimeNulls !== "last"
      )
        throw new ConfigurationError(
          "topPerPartition() has invalid null placement.",
        );
      const nullPlacement = resolveNullOrdering({ direction, nulls });
      return { expression, direction, nulls: nullPlacement };
    });
    const source = this.#materialize();
    const ast: TopPerPartitionRelation = {
      kind: "topPerPartition",
      source,
      columns: this.#definition.columns,
      partitionBy: [...partitionBy],
      orderBy,
      limit: options.limit,
    };
    return createExecutableRelation({
      ...this.#definition,
      ast,
    });
  }

  distinct(): ExecutableRelationQuery<Fields, Result> {
    assertPortableDistinctColumns(this.#definition.columns, "distinct()");
    const outputNames = new Set(
      this.#definition.columns.map((column) => column.outputName),
    );
    if (
      this.#state.orderBy.some(
        (order) =>
          order.expression.node.kind !== "field" ||
          order.expression.node.field.alias !== "relation" ||
          order.expression.node.field.path.length !== 1 ||
          !outputNames.has(order.expression.node.field.path[0] ?? ""),
      )
    )
      throw new ConfigurationError(
        "distinct() cannot preserve ordering by a graph expression that is absent from the explicit projection.",
      );
    return this.#copy({ ...this.#state, distinct: true });
  }

  distinctNodes(
    input: Readonly<{ kind: keyof Fields & string; id: keyof Fields & string }>,
  ): ExecutableRelationQuery<Fields, Result> {
    const { columns } = this.#definition;
    const kind = columns.find((column) => column.outputName === input.kind);
    const id = columns.find((column) => column.outputName === input.id);
    const valid =
      columns.length === 2 &&
      kind?.identity?.component === "kind" &&
      id?.identity?.component === "id" &&
      kind.identity.alias === id.identity.alias &&
      !kind.nullable &&
      !id.nullable &&
      kind.valueType === "string" &&
      id.valueType === "string";
    if (!valid)
      throw new ConfigurationError(
        "distinctNodes() requires an identity-only projection of non-null kind and id fields from the same node alias.",
      );
    return this.distinct();
  }

  limit(value: number): ExecutableRelationQuery<Fields, Result> {
    validateQueryRange(value, "limit");
    return this.#copy({ ...this.#state, limit: value });
  }

  offset(value: number): ExecutableRelationQuery<Fields, Result> {
    validateQueryRange(value, "offset");
    return this.#copy({ ...this.#state, offset: value });
  }

  map<Mapped>(
    mapper: (row: Result) => Mapped,
  ): ExecutableRelationQuery<Fields, Mapped> {
    return new ExecutableRelationQuery(
      {
        ...this.#definition,
        decodeRow: (row) => mapper(this.#definition.decodeRow(row)),
        mapped: true,
      },
      this.#state,
      this.#scopeIdentity,
    );
  }

  union<Other extends CompatibleRelationProjection<Fields>>(
    other: ExecutableRelationQuery<Other>,
  ) {
    return this.#set("union", other);
  }
  unionAll<Other extends CompatibleRelationProjection<Fields>>(
    other: ExecutableRelationQuery<Other>,
  ) {
    return this.#set("unionAll", other);
  }
  intersect<Other extends CompatibleRelationProjection<Fields>>(
    other: ExecutableRelationQuery<Other>,
  ) {
    return this.#set("intersect", other);
  }
  except<Other extends CompatibleRelationProjection<Fields>>(
    other: ExecutableRelationQuery<Other>,
  ) {
    return this.#set("except", other);
  }

  #set<Other extends CompatibleRelationProjection<Fields>>(
    operator: "union" | "unionAll" | "intersect" | "except",
    other: ExecutableRelationQuery<Other>,
  ): ExecutableRelationQuery<Fields, Result> {
    const right = other.#materializedDefinition();
    assertCompatibleRelationColumns(this.#definition.columns, right.columns);
    assertCompatibleProvenance(this.#definition.provenance, right.provenance);
    if (this.#definition.mapped === true || right.mapped === true)
      throw new ConfigurationError(
        "Set operations cannot combine post-execution mapped relations.",
      );
    if (operator !== "unionAll")
      assertPortableDistinctColumns(this.#definition.columns, `${operator}()`);
    const columns = mergedSetColumns(this.#definition.columns, right.columns);
    return createExecutableRelation({
      ...this.#definition,
      columns,
      ast: {
        kind: "set",
        operator,
        left: this.#materialize(),
        right: right.ast,
        columns,
      },
    });
  }

  compile() {
    return this.#compileForBackend(
      this.#definition.config.backend,
      this.#materialize(),
    );
  }

  #compileForBackend(
    backend: GraphBackend | TransactionBackend | undefined,
    relation: RelationAst,
  ) {
    this.#assertWindowFunctionsSupported(backend, relation);
    this.#assertRelationBound(relation);
    return compileRelation(relation, getDialect(this.#dialect()));
  }

  toSQL(): Readonly<{ sql: string; params: readonly unknown[] }> {
    return renderQuerySql(this.#requireBackend(), () => this.compile());
  }

  prepare(): Readonly<{
    execute: (
      bindings: Readonly<Record<string, unknown>>,
    ) => Promise<readonly Result[]>;
    bind: (
      bindings: Readonly<Record<string, unknown>>,
    ) => ExecutableRelationQuery<Fields, Result>;
  }>;
  prepare<const Parameters extends PreparedParameterDeclaration>(
    parameters: Parameters,
  ): Readonly<{
    execute: (
      bindings: PreparedBindings<Parameters>,
    ) => Promise<readonly Result[]>;
    bind: (
      bindings: PreparedBindings<Parameters>,
    ) => ExecutableRelationQuery<Fields, Result>;
  }>;
  prepare(parameters?: PreparedParameterDeclaration) {
    const definition = this.#materializedDefinition();
    const queries = relationQueries(definition.ast);
    const expressions = relationExpressions(definition.ast);
    if (parameters !== undefined)
      validatePreparedBindingsDeclaration(parameters, queries, expressions);
    const bind = (bindings: Readonly<Record<string, unknown>>) => {
      validateQueryBindings(queries, bindings, expressions);
      return new ExecutableRelationQuery(
        {
          ...this.#definition,
          ast: bindRelation(this.#definition.ast, bindings),
        },
        bindState(this.#state, bindings),
        this.#scopeIdentity,
      );
    };
    return {
      bind,
      execute: async (bindings: Readonly<Record<string, unknown>>) => {
        validateQueryBindings(queries, bindings, expressions);
        const rows = await this.#fetchRows(
          this.#requireBackend(),
          definition.ast,
          bindings,
        );
        return rows.map((row) => definition.decodeRow(row));
      },
    };
  }

  execute(): Promise<readonly Result[]> {
    return this.executeOn(this.#requireBackend());
  }

  async executeOn(
    backend: GraphBackend | TransactionBackend,
  ): Promise<readonly Result[]> {
    if (this.#definition.provenance.checked)
      throw new ConfigurationError(
        "Derived relations are unavailable inside withCheckedReads().",
      );
    if (
      backendDerivationRoot(backend) !==
      this.#definition.provenance.executionTarget
    )
      throw new ConfigurationError(
        "A relation cannot execute on a different database or transaction target.",
      );
    const rows = await this.#fetchRows(backend, this.#materialize());
    return rows.map((row) => this.#definition.decodeRow(row));
  }

  async first(): Promise<Result | undefined> {
    const rows = await this.limit(
      Math.min(this.#state.limit ?? 1, 1),
    ).execute();
    return rows[0];
  }
  async count(): Promise<number> {
    return this.#scalar("count");
  }
  async exists(): Promise<boolean> {
    return (await this.#scalar("exists")) > 0;
  }

  async page(
    options: Readonly<{ limit: number; offset?: number }>,
  ): Promise<readonly Result[]> {
    validateQueryRange(options.limit, "limit");
    if (options.limit === 0)
      throw new ConfigurationError(
        "Relation page limit must be greater than zero.",
      );
    const relativeOffset = options.offset ?? 0;
    validateQueryRange(relativeOffset, "offset");
    this.#assertDeterministicPageShape();
    const existingOffset = this.#state.offset ?? 0;
    const combinedOffset = existingOffset + relativeOffset;
    validateQueryRange(combinedOffset, "offset");
    const remaining =
      this.#state.limit === undefined ?
        undefined
      : Math.max(this.#state.limit - relativeOffset, 0);
    const limit =
      remaining === undefined ?
        options.limit
      : Math.min(options.limit, remaining);
    if (limit === 0) return [];
    return this.#copy({
      ...this.#state,
      limit,
      offset: combinedOffset,
    }).execute();
  }

  async *stream(
    options: Readonly<{ pageSize?: number }> = {},
  ): AsyncIterable<Result> {
    const pageSize = options.pageSize ?? 100;
    validateQueryRange(pageSize, "limit");
    if (pageSize === 0)
      throw new ConfigurationError(
        "Relation stream page size must be greater than zero.",
      );
    this.#assertDeterministicPageShape();
    const totalLimit = this.#state.limit;
    for (
      let offset = 0;
      totalLimit === undefined || offset < totalLimit;
      offset += pageSize
    ) {
      const rows = await this.page({ limit: pageSize, offset });
      for (const row of rows) yield row;
      if (
        rows.length <
        Math.min(
          pageSize,
          totalLimit === undefined ? pageSize : totalLimit - offset,
        )
      )
        return;
    }
  }

  #assertDeterministicPageShape(): void {
    if (!this.#state.distinct)
      throw new ConfigurationError(
        "Relation paging and streaming require distinct() over the whole projection.",
      );
    assertPortableDistinctColumns(
      this.#definition.columns,
      "Relation paging and streaming",
    );
    const orderedNames = this.#state.orderBy.map((order) =>
      (
        order.expression.node.kind === "field" &&
        order.expression.node.field.alias === "relation" &&
        order.expression.node.field.path.length === 1
      ) ?
        order.expression.node.field.path[0]
      : undefined,
    );
    const expected = this.#definition.columns.map(
      (column) => column.outputName,
    );
    if (
      orderedNames.length !== expected.length ||
      new Set(orderedNames).size !== expected.length ||
      expected.some((name) => !orderedNames.includes(name))
    )
      throw new ConfigurationError(
        "Relation paging and streaming require direct ordering by every projected column exactly once.",
      );
  }

  async #scalar(operation: "count" | "exists"): Promise<number> {
    if (this.#definition.provenance.checked)
      throw new ConfigurationError(
        "Derived relation terminals are unavailable inside withCheckedReads().",
      );
    const backend = this.#requireBackend();
    const relation = this.#materialize();
    this.#assertWindowFunctionsSupported(backend, relation);
    this.#assertRelationBound(relation);
    const executeRaw = backend.executeRaw;
    const template =
      executeRaw === undefined ? undefined : (
        this.#resolveScalarTemplate(relation, operation)
      );
    const operationPromise =
      template !== undefined && executeRaw !== undefined ?
        executeRaw<Record<string, unknown>>(
          template.sql,
          fillTemplateParams(template.params, {}, this.#dialect()),
        )
      : backend.execute<Record<string, unknown>>(
          this.#compileScalar(relation, operation),
        );
    const rows =
      this.#definition.provenance.recordedAsOf === undefined ?
        await operationPromise
      : await withRecordedRelationsPrecondition(operationPromise, {
          dialect: backend.dialect,
          surface: "recorded-relation-terminal",
        });
    return Number(rows[0]?.["__tg_scalar"] ?? 0);
  }

  #compileScalar(
    relation: RelationAst,
    operation: "count" | "exists",
    placeholderReadInstant = false,
  ) {
    const compiledRelation = compileRelation(
      placeholderReadInstant ? withPlaceholderReadInstants(relation) : relation,
      getDialect(this.#dialect()),
    );
    return asCompiledSelectSql(
      operation === "count" ?
        sql`SELECT COUNT(*) AS __tg_scalar FROM (${compiledRelation}) AS typegraph_relation_count`
      : sql`SELECT CASE WHEN EXISTS (${compiledRelation}) THEN 1 ELSE 0 END AS __tg_scalar`,
    );
  }

  #resolveScalarTemplate(
    relation: RelationAst,
    operation: "count" | "exists",
  ): CompiledTemplate | undefined {
    if (this.#scalarTemplates.has(operation))
      return this.#scalarTemplates.get(operation);
    const template = buildReadInstantTemplate({
      compile: () => this.#compileScalar(relation, operation, true),
      backend: this.#definition.config.backend,
      needsReadInstant: relationNeedsCurrentReadInstant(relation),
    });
    this.#scalarTemplates.set(operation, template);
    return template;
  }

  compileOneStatementBatchItem() {
    if (this.#definition.provenance.checked)
      throw new ConfigurationError(
        "Checked relations cannot be embedded in batchOnce().",
      );
    if (this.#definition.provenance.recordedAsOf !== undefined)
      throw new ConfigurationError(
        "Recorded relations cannot be embedded in batchOnce().",
      );
    const backend = this.#requireBackend();
    return {
      query: this.compile(),
      provenance: {
        graphId: this.#definition.provenance.graphId,
        executionTarget: backendDerivationRoot(backend),
      },
      outputNames: this.#definition.columns.map((column) => column.outputName),
      orderBy: this.#state.orderBy.map((order, index) => ({
        column: `__tg_relation_order_${index}`,
        direction: order.direction,
        nulls: order.nulls,
      })),
      mapRows: (rows: readonly Record<string, unknown>[]) =>
        rows.map((row) => this.#definition.decodeRow(row)),
    };
  }

  #requireBackend(): GraphBackend | TransactionBackend {
    if (this.#definition.config.backend === undefined)
      throw new ConfigurationError(
        "Relation execution requires a backend; use store.query().",
      );
    return this.#definition.config.backend;
  }

  #dialect(): "sqlite" | "postgres" {
    return this.#definition.config.dialect ?? "sqlite";
  }

  /** Resolves the per-instance placeholder template for this immutable relation. */
  #resolveTemplate(relation: RelationAst): CompiledTemplate | undefined {
    if (this.#template !== NOT_COMPUTED) return this.#template;
    this.#template = buildReadInstantTemplate({
      compile: () =>
        compileRelation(
          withPlaceholderReadInstants(relation),
          getDialect(this.#dialect()),
        ),
      backend: this.#definition.config.backend,
      needsReadInstant: relationNeedsCurrentReadInstant(relation),
    });
    return this.#template;
  }

  /**
   * Executes either the cached raw template or a freshly compiled concrete
   * relation. Binding substitution is deliberately confined to the fallback:
   * the raw path retains user placeholders so one prepared relation serves
   * every binding set and receives a fresh current-time instant per call.
   */
  async #fetchRows(
    backend: GraphBackend | TransactionBackend,
    relation: RelationAst,
    bindings?: Readonly<Record<string, unknown>>,
  ): Promise<readonly Record<string, unknown>[]> {
    this.#assertWindowFunctionsSupported(backend, relation);
    const metadata = collectParameterMetadata(
      relationQueries(relation),
      relationExpressions(relation),
    );
    if (bindings === undefined) this.#assertRelationBound(relation, metadata);

    const executeRaw = backend.executeRaw;
    const template =
      executeRaw === undefined ? undefined : this.#resolveTemplate(relation);
    const operation =
      template !== undefined && executeRaw !== undefined ?
        executeRaw<Record<string, unknown>>(
          template.sql,
          fillTemplateParams(
            template.params,
            bindings ?? {},
            this.#dialect(),
            metadata.listParameters,
          ),
        )
      : backend.execute<Record<string, unknown>>(
          compileRelation(
            bindings === undefined ? relation : (
              bindRelation(relation, bindings)
            ),
            getDialect(this.#dialect()),
          ),
        );
    return this.#definition.provenance.recordedAsOf === undefined ?
        operation
      : withRecordedRelationsPrecondition(operation, {
          dialect: backend.dialect,
          surface: "recorded-relation",
        });
  }

  #assertRelationBound(
    relation: RelationAst,
    metadata = collectParameterMetadata(
      relationQueries(relation),
      relationExpressions(relation),
    ),
  ): void {
    if (metadata.names.size === 0) return;
    throw new ConfigurationError(
      "Relation contains unbound parameters; use prepare().execute(bindings).",
    );
  }

  #assertWindowFunctionsSupported(
    backend: GraphBackend | TransactionBackend | undefined = this.#definition
      .config.backend,
    relation = this.#materialize(),
  ): void {
    if (
      backend?.capabilities.windowFunctions === false &&
      relationHasTopPerPartition(relation)
    )
      throw new UnsupportedBackendCapabilityError(
        "topPerPartition()",
        "windowFunctions",
      );
  }
}

export type CompatibleRelationProjection<Fields extends RelationProjection> =
  Readonly<{
    [Key in keyof Fields]: DatabaseExpression<
      RelationProjectionResult<Fields>[Key]
    >;
  }>;

export function createExecutableRelation<
  Fields extends RelationProjection,
  Result,
>(
  definition: RelationDefinition<Fields, Result>,
): ExecutableRelationQuery<Fields, Result> {
  return new ExecutableRelationQuery(definition);
}

export function createProjectionRelation<
  Fields extends RelationProjection,
  Result,
>(
  input: Readonly<{
    config: QueryBuilderConfig;
    ast: QueryAst;
    fields: Fields;
    decodeRow: (row: Record<string, unknown>) => Result;
    checked: boolean;
    mapped?: boolean;
  }>,
): ExecutableRelationQuery<Fields, Result> {
  const nodeAliases = new Set([
    input.ast.start.alias,
    ...input.ast.traversals.map((traversal) => traversal.nodeAlias),
  ]);
  const columns = relationColumns(input.fields, { nodeAliases });
  const ordering = input.ast.orderBy ?? [];
  const orderOutputNames = ordering.map(
    (order) =>
      input.ast.projection.fields.find(
        (projected) =>
          projected.source === order.field ||
          (projected.source.__type === "database_expression" &&
            order.field.__type === "database_expression" &&
            projected.source.node.kind === "field" &&
            order.field.node.kind === "field" &&
            projected.source.node.field.alias ===
              order.field.node.field.alias &&
            projected.source.node.field.path.join("\u0000") ===
              order.field.node.field.path.join("\u0000") &&
            projected.source.node.field.jsonPointer ===
              order.field.node.field.jsonPointer),
      )?.outputName,
  );
  const {
    limit: sourceLimit,
    offset: sourceOffset,
    orderBy: _sourceOrderBy,
    ...unboundedSourceAst
  } = input.ast;
  const sourceAst: QueryAst = {
    ...unboundedSourceAst,
    projection: {
      ...input.ast.projection,
      fields: [
        ...input.ast.projection.fields,
        ...ordering.flatMap((order, index) =>
          orderOutputNames[index] === undefined ?
            [
              {
                outputName: `__tg_relation_source_order_${index}`,
                source: order.field,
              },
            ]
          : [],
        ),
      ],
    },
  };
  const definition: RelationDefinition<Fields, Result> = {
    ast: {
      kind: "source",
      query: sourceAst,
      graphId: input.config.graphId,
      options: buildCompileOptions(input.config),
    },
    columns,
    fields: input.fields,
    config: input.config,
    provenance: {
      graphId: input.config.graphId,
      executionTarget:
        input.config.backend === undefined ?
          undefined
        : backendDerivationRoot(input.config.backend),
      recordedAsOf: input.ast.recordedAsOf,
      checked: input.checked,
      temporalCoordinate: JSON.stringify(input.ast.temporalMode),
    },
    decodeRow: input.decodeRow,
    ...(input.mapped === undefined ? {} : { mapped: input.mapped }),
  };
  const scopeIdentity = relationScope();
  const state: RelationState = {
    distinct: false,
    ...(sourceLimit === undefined ? {} : { limit: sourceLimit }),
    ...(sourceOffset === undefined ? {} : { offset: sourceOffset }),
    orderBy: ordering.map((order, index) => ({
      expression: createFieldExpression(
        outputField(
          orderOutputNames[index] ?? `__tg_relation_source_order_${index}`,
          order.field.valueType ?? "unknown",
        ),
        scopeIdentity,
        true,
      ),
      direction: order.direction,
      nulls: resolveNullOrdering(order),
    })),
  };
  return new ExecutableRelationQuery(definition, state, scopeIdentity);
}
