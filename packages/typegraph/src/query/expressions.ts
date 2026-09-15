import { UnsupportedPredicateError } from "../errors";
import {
  assertPortableCountDistinctValueType,
  assertPortableScalarValueType,
} from "./aggregate-value-types";
import type { FieldRef, QueryAst, ValueType } from "./ast";

type DatabaseJsonValue =
  | boolean
  | number
  | string
  | null
  | readonly DatabaseJsonValue[]
  | Readonly<{ [key: string]: DatabaseJsonValue }>;

export type DatabaseLiteral = DatabaseJsonValue | Date | undefined;

export type ArithmeticOperator = "add" | "divide" | "multiply" | "subtract";
export type ExpressionComparisonOperator =
  "eq" | "gt" | "gte" | "lt" | "lte" | "neq";
export type AggregateOperator =
  "avg" | "count" | "countDistinct" | "max" | "min" | "sum";

export type CollectOrder<Scope extends string = string> = Readonly<{
  expression: DatabaseExpression<
    boolean | Date | number | string | undefined,
    Scope
  >;
  direction?: "asc" | "desc";
  nulls?: "first" | "last";
}>;

/** Options for ordered scalar collection aggregation. */
export type CollectOptions<Scope extends string = string> = Readonly<{
  orderBy: readonly [CollectOrder<Scope>, ...CollectOrder<Scope>[]];
}>;

export type CollectExpressionNode = Readonly<{
  kind: "collect";
  operand: DatabaseExpression;
  orderBy: readonly CollectOrder[];
}>;

type FieldExpressionNode = Readonly<{
  kind: "field";
  field: FieldRef;
}>;
type LiteralExpressionNode = Readonly<{
  kind: "literal";
  value: DatabaseLiteral;
}>;
type ParameterExpressionNode = Readonly<{
  kind: "parameter";
  name: string;
}>;
type ArithmeticExpressionNode = Readonly<{
  kind: "arithmetic";
  operator: ArithmeticOperator;
  left: DatabaseExpression;
  right: DatabaseExpression;
}>;
type ComparisonExpressionNode = Readonly<{
  kind: "comparison";
  operator: ExpressionComparisonOperator;
  left: DatabaseExpression;
  right: DatabaseExpression;
}>;
type BooleanExpressionNode = Readonly<{
  kind: "boolean";
  operator: "and" | "or";
  operands: readonly DatabaseExpression<boolean | undefined>[];
}>;
type NotExpressionNode = Readonly<{
  kind: "not";
  operand: DatabaseExpression<boolean | undefined>;
}>;
type NullCheckExpressionNode = Readonly<{
  kind: "null_check";
  operator: "isNull" | "isNotNull";
  operand: DatabaseExpression;
}>;
type AggregateExpressionNode = Readonly<{
  kind: "aggregate";
  operator: AggregateOperator;
  operand?: DatabaseExpression | undefined;
}>;
type CoalesceExpressionNode = Readonly<{
  kind: "coalesce";
  operands: readonly DatabaseExpression[];
}>;
type ConditionalExpressionNode = Readonly<{
  kind: "conditional";
  condition: DatabaseExpression<boolean | undefined>;
  then: DatabaseExpression;
  otherwise: DatabaseExpression;
}>;
type NumericConversionExpressionNode = Readonly<{
  kind: "numeric_conversion";
  operand: DatabaseExpression;
}>;
type OuterReferenceExpressionNode = Readonly<{
  kind: "outer_reference";
  expression: DatabaseExpression;
  outerScopeIdentity: symbol;
}>;
type ExistsSubqueryExpressionNode = Readonly<{
  kind: "exists_subquery";
  subquery: QueryAst;
}>;
type ScalarSubqueryExpressionNode = Readonly<{
  kind: "scalar_subquery";
  subquery: QueryAst;
}>;

export type DatabaseExpressionNode =
  | AggregateExpressionNode
  | ArithmeticExpressionNode
  | BooleanExpressionNode
  | CoalesceExpressionNode
  | CollectExpressionNode
  | ComparisonExpressionNode
  | ConditionalExpressionNode
  | ExistsSubqueryExpressionNode
  | FieldExpressionNode
  | LiteralExpressionNode
  | NotExpressionNode
  | NullCheckExpressionNode
  | NumericConversionExpressionNode
  | OuterReferenceExpressionNode
  | ParameterExpressionNode
  | ScalarSubqueryExpressionNode;

/** A portable database expression carrying its decoded type and query scope. */
export type DatabaseExpression<
  out T = unknown,
  out Scope extends string = string,
> = Readonly<{
  __type: "database_expression";
  node: DatabaseExpressionNode;
  valueType: ValueType;
  /** Scalar element type carried by collection-valued expressions. */
  elementValueType?: ValueType;
  nullable: boolean;
  scopeIdentity: symbol;
  /** @internal Carries the public result type without runtime data. */
  __value?: T;
  /** @internal Carries the public query scope without exposing SQL aliases. */
  __scope?: Scope;
}>;

type NonNull<T> = Exclude<T, undefined>;
type LiteralResult<T> = T extends null ? undefined : T;
type ParameterValue<Value extends ValueType> =
  Value extends "boolean" ? boolean
  : Value extends "date" ? Date
  : Value extends "number" ? number
  : Value extends "string" ? string
  : Value extends "array" ? readonly DatabaseJsonValue[]
  : Value extends "object" ? Readonly<Record<string, DatabaseJsonValue>>
  : unknown;
type Comparable = boolean | Date | number | string;
type OrderedComparable = Date | number | string;
type NullIfEitherUndefined<Left, Right, Value> =
  undefined extends Left | Right ? Value | undefined : Value;
type NumericExpression<Scope extends string> = DatabaseExpression<
  number | undefined,
  Scope
>;
type ComparableExpression<
  T extends Comparable,
  Scope extends string,
> = DatabaseExpression<T | undefined, Scope>;

const UNSCOPED_EXPRESSION = Symbol("unscoped database expression");

function createExpression<T, Scope extends string>(
  node: DatabaseExpressionNode,
  valueType: ValueType,
  nullable: boolean,
  scopeIdentity: symbol,
  elementValueType?: ValueType,
): DatabaseExpression<T, Scope> {
  return {
    __type: "database_expression",
    node,
    nullable,
    scopeIdentity,
    valueType,
    ...(elementValueType === undefined ? {} : { elementValueType }),
  };
}

function assertExpression(value: unknown): asserts value is DatabaseExpression {
  if (
    typeof value !== "object" ||
    value === null ||
    !("__type" in value) ||
    value.__type !== "database_expression"
  ) {
    throw new TypeError("Expected a database expression operand");
  }
}

function resolveScope(expressions: readonly DatabaseExpression[]): symbol {
  for (const expression of expressions) assertExpression(expression);
  const scoped = expressions.filter(
    (expression) => expression.scopeIdentity !== UNSCOPED_EXPRESSION,
  );
  const firstScope = scoped[0]?.scopeIdentity;
  if (
    firstScope !== undefined &&
    scoped.some((expression) => expression.scopeIdentity !== firstScope)
  ) {
    throw new TypeError(
      "Database expression operands belong to different query scopes",
    );
  }
  return firstScope ?? UNSCOPED_EXPRESSION;
}

function assertSameValueType(
  expressions: readonly DatabaseExpression[],
): ValueType {
  const valueType = expressions[0]?.valueType;
  if (valueType === undefined)
    throw new TypeError("At least one database expression is required");
  if (valueType === "unknown")
    throw new TypeError("Unknown expression value types cannot be combined");
  if (expressions.some((expression) => expression.valueType !== valueType)) {
    throw new TypeError(
      "Database expression operands have incompatible value types",
    );
  }
  if (
    valueType === "array" &&
    expressions.some(
      (expression) =>
        expression.elementValueType !== expressions[0]?.elementValueType,
    )
  )
    throw new TypeError(
      "Database array expression operands have incompatible element value types",
    );
  return valueType;
}

function inferLiteralType(value: DatabaseLiteral): ValueType {
  if (value === undefined || value === null) return "unknown";
  if (value instanceof Date) return "date";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "string";
}

function validateJsonLiteral(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): asserts value is DatabaseJsonValue {
  if (value === undefined)
    throw new TypeError(`JSON literal value at ${path} cannot be undefined`);
  if (typeof value === "number" && !Number.isFinite(value))
    throw new TypeError(`JSON literal number at ${path} must be finite`);
  if (Array.isArray(value)) {
    if (ancestors.has(value))
      throw new TypeError(`JSON literal at ${path} cannot contain a cycle`);
    ancestors.add(value);
    for (const [index, element] of value.entries())
      validateJsonLiteral(element, `${path}[${index}]`, ancestors);
    ancestors.delete(value);
    return;
  }
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError(`Value at ${path} must be a plain JSON object`);
    if (ancestors.has(value))
      throw new TypeError(`JSON literal at ${path} cannot contain a cycle`);
    ancestors.add(value);
    for (const [key, element] of Object.entries(value))
      validateJsonLiteral(element, `${path}.${key}`, ancestors);
    ancestors.delete(value);
    return;
  }
  if (
    value !== null &&
    typeof value !== "boolean" &&
    typeof value !== "number" &&
    typeof value !== "string"
  )
    throw new TypeError(`Value at ${path} is not a JSON literal`);
}

/** Validates and snapshots a value accepted by expression literals and bindings. */
export function normalizeDatabaseLiteral(
  value: unknown,
  contextName = "$literal",
): DatabaseLiteral {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime()))
      throw new TypeError(`${contextName} must be a valid Date`);
    return new Date(value);
  }
  if (value === undefined) return undefined;
  validateJsonLiteral(value, contextName, new WeakSet());
  return typeof value === "object" && value !== null ?
      structuredClone(value)
    : value;
}

export function createFieldExpression<T, Scope extends string>(
  field: FieldRef<T>,
  scopeIdentity: symbol,
  nullable: false,
): DatabaseExpression<Exclude<T, undefined>, Scope>;
export function createFieldExpression<T, Scope extends string>(
  field: FieldRef<T>,
  scopeIdentity: symbol,
  nullable: true,
): DatabaseExpression<Exclude<T, undefined> | undefined, Scope>;
export function createFieldExpression<T, Scope extends string>(
  field: FieldRef<T>,
  scopeIdentity: symbol,
  nullable: boolean,
): DatabaseExpression<T | undefined, Scope>;
export function createFieldExpression<T, Scope extends string>(
  field: FieldRef<T>,
  scopeIdentity: symbol,
  nullable: boolean,
): DatabaseExpression<T | undefined, Scope> {
  return createExpression(
    { field, kind: "field" },
    field.valueType ?? "unknown",
    nullable,
    scopeIdentity,
  );
}

/** @internal Rebinds an outer field into a child expression scope. */
export function createOuterReferenceExpression<T, Scope extends string>(
  expression: DatabaseExpression<T>,
  childScopeIdentity: symbol,
): DatabaseExpression<T, Scope> {
  if (expression.node.kind !== "field") {
    throw new TypeError("Outer query references must be field expressions");
  }
  return createExpression(
    {
      expression,
      kind: "outer_reference",
      outerScopeIdentity: expression.scopeIdentity,
    },
    expression.valueType,
    expression.nullable,
    childScopeIdentity,
  );
}

/** @internal Creates a correlated EXISTS expression in its parent scope. */
export function createExistsSubqueryExpression<Scope extends string>(
  subquery: QueryAst,
  parentScopeIdentity: symbol,
): DatabaseExpression<boolean, Scope> {
  return createExpression(
    { kind: "exists_subquery", subquery },
    "boolean",
    false,
    parentScopeIdentity,
  );
}

/** @internal Creates a nullable scalar subquery expression in its parent scope. */
export function createScalarSubqueryExpression<T, Scope extends string>(
  subquery: QueryAst,
  projected: DatabaseExpression<T>,
  parentScopeIdentity: symbol,
): DatabaseExpression<T | undefined, Scope> {
  return createExpression(
    { kind: "scalar_subquery", subquery },
    projected.valueType,
    true,
    parentScopeIdentity,
    projected.elementValueType,
  );
}

function literal<T extends DatabaseLiteral>(
  value: T,
): DatabaseExpression<LiteralResult<T>, never> {
  const storedValue = normalizeDatabaseLiteral(value) as T;
  return createExpression(
    { kind: "literal", value: storedValue },
    inferLiteralType(value),
    inferLiteralType(value) === "unknown",
    UNSCOPED_EXPRESSION,
  );
}

function parameter<Value extends ValueType>(
  name: string,
  valueType: Value,
): DatabaseExpression<ParameterValue<Value>, never> {
  if (name.length === 0) throw new TypeError("Parameter names cannot be empty");
  if (valueType === "unknown")
    throw new TypeError("Parameters require a concrete value type");
  return createExpression(
    { kind: "parameter", name },
    valueType,
    false,
    UNSCOPED_EXPRESSION,
  );
}

function arithmetic<
  Operator extends ArithmeticOperator,
  Left extends number | undefined,
  Right extends number | undefined,
  Scope extends string,
>(
  operator: Operator,
  left: DatabaseExpression<Left, Scope>,
  right: DatabaseExpression<Right, Scope>,
): DatabaseExpression<
  Operator extends "divide" ? number | undefined
  : NullIfEitherUndefined<Left, Right, number>,
  Scope
> {
  const scopeIdentity = resolveScope([left, right]);
  if (left.valueType !== "number" || right.valueType !== "number")
    throw new TypeError("Arithmetic operands must be numeric expressions");
  return createExpression(
    { kind: "arithmetic", left, operator, right },
    "number",
    left.nullable || right.nullable || operator === "divide",
    scopeIdentity,
  );
}

function comparison<
  Left extends Comparable | undefined,
  Right extends NonNull<Left> | undefined,
  Scope extends string,
>(
  operator: ExpressionComparisonOperator,
  left: DatabaseExpression<Left, Scope>,
  right: DatabaseExpression<Right, Scope>,
): DatabaseExpression<NullIfEitherUndefined<Left, Right, boolean>, Scope> {
  const scopeIdentity = resolveScope([left, right]);
  assertSameValueType([left, right]);
  return createExpression(
    { kind: "comparison", left, operator, right },
    "boolean",
    left.nullable || right.nullable,
    scopeIdentity,
  );
}

function booleanComposition<Scope extends string>(
  operator: "and" | "or",
  operands: readonly DatabaseExpression<boolean | undefined, Scope>[],
): DatabaseExpression<boolean | undefined, Scope> {
  if (operands.length === 0)
    throw new TypeError(`Boolean ${operator} requires at least one operand`);
  const scopeIdentity = resolveScope(operands);
  if (operands.some((operand) => operand.valueType !== "boolean"))
    throw new TypeError("Boolean operands must be Boolean expressions");
  return createExpression(
    { kind: "boolean", operands, operator },
    "boolean",
    operands.some((operand) => operand.nullable),
    scopeIdentity,
  );
}

function not<Scope extends string>(
  operand: DatabaseExpression<boolean | undefined, Scope>,
): DatabaseExpression<boolean | undefined, Scope> {
  const scopeIdentity = resolveScope([operand]);
  if (operand.valueType !== "boolean")
    throw new TypeError("NOT requires a Boolean expression");
  return createExpression(
    { kind: "not", operand },
    "boolean",
    operand.nullable,
    scopeIdentity,
  );
}

function nullCheck<T, Scope extends string>(
  operator: "isNull" | "isNotNull",
  operand: DatabaseExpression<T, Scope>,
): DatabaseExpression<boolean, Scope> {
  return createExpression(
    { kind: "null_check", operand, operator },
    "boolean",
    false,
    resolveScope([operand]),
  );
}

function isNull<T, Scope extends string>(
  operand: DatabaseExpression<T, Scope>,
): DatabaseExpression<boolean, Scope> {
  return nullCheck("isNull", operand);
}

function isNotNull<T, Scope extends string>(
  operand: DatabaseExpression<T, Scope>,
): DatabaseExpression<boolean, Scope> {
  return nullCheck("isNotNull", operand);
}

function aggregate<T, Scope extends string>(
  operator: AggregateOperator,
  operand: DatabaseExpression<T, Scope> | undefined,
  valueType: ValueType,
): DatabaseExpression<number | undefined, Scope> {
  const scopeIdentity =
    operand === undefined ? UNSCOPED_EXPRESSION : resolveScope([operand]);
  return createExpression(
    { kind: "aggregate", operand, operator },
    valueType,
    operator !== "count" && operator !== "countDistinct",
    scopeIdentity,
  );
}

function count<Scope extends string = never>(
  operand?: DatabaseExpression<unknown, Scope>,
): DatabaseExpression<number, Scope> {
  return aggregate("count", operand, "number") as DatabaseExpression<
    number,
    Scope
  >;
}

function countDistinct<Scope extends string>(
  operand: DatabaseExpression<
    boolean | Date | number | string | undefined,
    Scope
  >,
): DatabaseExpression<number, Scope> {
  assertPortableCountDistinctValueType(operand.valueType);
  return aggregate("countDistinct", operand, "number") as DatabaseExpression<
    number,
    Scope
  >;
}

/** Validates and resolves collection ordering for builders and raw expression compilation. */
export function resolveCollectOrder<Scope extends string>(
  orderBy: readonly CollectOrder<Scope>[] | undefined,
): readonly Readonly<{
  expression: CollectOrder<Scope>["expression"];
  direction: "asc" | "desc";
  nulls: "first" | "last";
}>[] {
  if (!Array.isArray(orderBy) || orderBy.length === 0)
    throw new UnsupportedPredicateError(
      "COLLECT requires at least one ordering expression",
    );
  return orderBy.map((order: CollectOrder<Scope>) => {
    assertPortableScalarValueType(
      order.expression.valueType,
      "COLLECT ordering",
    );
    const direction = order.direction ?? "asc";
    if (!["asc", "desc"].includes(direction))
      throw new UnsupportedPredicateError(
        "COLLECT ordering direction must be asc or desc",
      );
    const nulls = order.nulls ?? (direction === "asc" ? "last" : "first");
    if (!["first", "last"].includes(nulls))
      throw new UnsupportedPredicateError(
        "COLLECT null ordering must be first or last",
      );
    return { expression: order.expression, direction, nulls };
  });
}

function collect<T extends Comparable | undefined, Scope extends string>(
  operand: DatabaseExpression<T, Scope>,
  options: CollectOptions<Scope>,
): DatabaseExpression<readonly T[], Scope> {
  assertPortableScalarValueType(operand.valueType, "COLLECT");
  const orderBy = resolveCollectOrder(options.orderBy);
  const scopeIdentity = resolveScope([
    operand,
    ...orderBy.map((order) => order.expression),
  ]);
  return createExpression(
    { kind: "collect", operand, orderBy },
    "array",
    false,
    scopeIdentity,
    operand.valueType,
  );
}

function numericAggregate<Scope extends string>(
  operator: "avg" | "sum",
  operand: NumericExpression<Scope>,
): NumericExpression<Scope> {
  if (operand.valueType !== "number")
    throw new TypeError(`${operator} requires a numeric expression`);
  return aggregate(operator, operand, "number");
}

function extrema<T extends OrderedComparable, Scope extends string>(
  operator: "max" | "min",
  operand: ComparableExpression<T, Scope>,
): DatabaseExpression<T | undefined, Scope> {
  if (
    operand.valueType !== "number" &&
    operand.valueType !== "string" &&
    operand.valueType !== "date"
  )
    throw new TypeError(`${operator} requires a comparable expression`);
  return createExpression(
    { kind: "aggregate", operand, operator },
    operand.valueType,
    true,
    resolveScope([operand]),
  );
}

function coalesce<T, Scope extends string>(
  first: DatabaseExpression<T | undefined, Scope>,
  fallback: DatabaseExpression<NoInfer<T>, Scope>,
  ...rest: readonly DatabaseExpression<NoInfer<T> | undefined, Scope>[]
): DatabaseExpression<T, Scope>;
function coalesce<T, Scope extends string>(
  first: DatabaseExpression<T | undefined, Scope>,
  ...rest: readonly DatabaseExpression<NoInfer<T> | undefined, Scope>[]
): DatabaseExpression<T | undefined, Scope> {
  const operands = [first, ...rest];
  const scopeIdentity = resolveScope(operands);
  const valueType = assertSameValueType(operands);
  return createExpression(
    { kind: "coalesce", operands },
    valueType,
    operands.every((operand) => operand.nullable),
    scopeIdentity,
    first.elementValueType,
  );
}

function when<
  Then,
  Otherwise extends NonNull<Then> | undefined,
  Scope extends string,
>(
  condition: DatabaseExpression<boolean | undefined, Scope>,
  then: DatabaseExpression<Then, Scope>,
  otherwise: DatabaseExpression<Otherwise, Scope>,
): DatabaseExpression<
  NullIfEitherUndefined<Then, Otherwise, NonNull<Then>>,
  Scope
> {
  const scopeIdentity = resolveScope([condition, then, otherwise]);
  if (condition.valueType !== "boolean")
    throw new TypeError("Conditional expressions require a Boolean condition");
  const valueType = assertSameValueType([then, otherwise]);
  return createExpression(
    // eslint-disable-next-line unicorn/no-thenable -- `then` is the SQL conditional branch.
    { condition, kind: "conditional", otherwise, then },
    valueType,
    then.nullable || otherwise.nullable,
    scopeIdentity,
    then.elementValueType,
  );
}

function toNumber<Scope extends string>(
  operand: DatabaseExpression<number | string | undefined, Scope>,
): NumericExpression<Scope> {
  const allowed =
    operand.valueType === "number" || operand.valueType === "string";
  if (!allowed)
    throw new TypeError(
      "Numeric conversion requires a string or number expression",
    );
  return createExpression(
    { kind: "numeric_conversion", operand },
    "number",
    true,
    resolveScope([operand]),
  );
}

export const expr = {
  add: <
    Left extends number | undefined,
    Right extends number | undefined,
    Scope extends string,
  >(
    left: DatabaseExpression<Left, Scope>,
    right: DatabaseExpression<Right, Scope>,
  ) => arithmetic("add", left, right),
  and: <Scope extends string>(
    ...operands: readonly DatabaseExpression<boolean | undefined, Scope>[]
  ) => booleanComposition("and", operands),
  avg: <Scope extends string>(operand: NumericExpression<Scope>) =>
    numericAggregate("avg", operand),
  coalesce,
  collect,
  count,
  countDistinct,
  divide: <
    Left extends number | undefined,
    Right extends number | undefined,
    Scope extends string,
  >(
    left: DatabaseExpression<Left, Scope>,
    right: DatabaseExpression<Right, Scope>,
  ) => arithmetic("divide", left, right),
  eq: <
    Left extends Comparable | undefined,
    Right extends NonNull<Left> | undefined,
    Scope extends string,
  >(
    left: DatabaseExpression<Left, Scope>,
    right: DatabaseExpression<Right, Scope>,
  ) => comparison("eq", left, right),
  gt: <
    Left extends Comparable | undefined,
    Right extends NonNull<Left> | undefined,
    Scope extends string,
  >(
    left: DatabaseExpression<Left, Scope>,
    right: DatabaseExpression<Right, Scope>,
  ) => comparison("gt", left, right),
  gte: <
    Left extends Comparable | undefined,
    Right extends NonNull<Left> | undefined,
    Scope extends string,
  >(
    left: DatabaseExpression<Left, Scope>,
    right: DatabaseExpression<Right, Scope>,
  ) => comparison("gte", left, right),
  isNotNull,
  isNull,
  literal,
  lt: <
    Left extends Comparable | undefined,
    Right extends NonNull<Left> | undefined,
    Scope extends string,
  >(
    left: DatabaseExpression<Left, Scope>,
    right: DatabaseExpression<Right, Scope>,
  ) => comparison("lt", left, right),
  lte: <
    Left extends Comparable | undefined,
    Right extends NonNull<Left> | undefined,
    Scope extends string,
  >(
    left: DatabaseExpression<Left, Scope>,
    right: DatabaseExpression<Right, Scope>,
  ) => comparison("lte", left, right),
  max: <T extends OrderedComparable, Scope extends string>(
    operand: ComparableExpression<T, Scope>,
  ) => extrema("max", operand),
  min: <T extends OrderedComparable, Scope extends string>(
    operand: ComparableExpression<T, Scope>,
  ) => extrema("min", operand),
  multiply: <
    Left extends number | undefined,
    Right extends number | undefined,
    Scope extends string,
  >(
    left: DatabaseExpression<Left, Scope>,
    right: DatabaseExpression<Right, Scope>,
  ) => arithmetic("multiply", left, right),
  neq: <
    Left extends Comparable | undefined,
    Right extends NonNull<Left> | undefined,
    Scope extends string,
  >(
    left: DatabaseExpression<Left, Scope>,
    right: DatabaseExpression<Right, Scope>,
  ) => comparison("neq", left, right),
  not,
  or: <Scope extends string>(
    ...operands: readonly DatabaseExpression<boolean | undefined, Scope>[]
  ) => booleanComposition("or", operands),
  param: parameter,
  subtract: <
    Left extends number | undefined,
    Right extends number | undefined,
    Scope extends string,
  >(
    left: DatabaseExpression<Left, Scope>,
    right: DatabaseExpression<Right, Scope>,
  ) => arithmetic("subtract", left, right),
  sum: <Scope extends string>(operand: NumericExpression<Scope>) =>
    numericAggregate("sum", operand),
  toNumber,
  when,
} as const;
