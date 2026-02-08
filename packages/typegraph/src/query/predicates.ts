/**
 * Predicate builders for TypeGraph queries.
 *
 * Provides a fluent API for building type-safe predicates.
 */
import {
  type ArrayOp,
  type ArrayPredicate,
  type BetweenPredicate,
  type ComparisonOp,
  type ComparisonPredicate,
  type ExistsSubquery,
  type FieldRef,
  type InSubquery,
  type LiteralValue,
  type NullPredicate,
  type ObjectOp,
  type ObjectPredicate,
  type PredicateExpression,
  type QueryAst,
  type StringOp,
  type StringPredicate,
  type ValueType,
  type VectorMetricType,
  type VectorSimilarityPredicate,
} from "./ast";
import { resolveFieldTypeInfoAtJsonPointer } from "./field-type-info";
import {
  joinJsonPointers,
  type JsonPointer,
  jsonPointer,
  type JsonPointerInput,
  type JsonPointerSegment,
  normalizeJsonPointer,
  type ResolveJsonPointer,
  type ResolveJsonPointerSegments,
} from "./json-pointer";
import { type FieldTypeInfo } from "./schema-introspector";

// ============================================================
// Predicate Builder
// ============================================================

/**
 * A chainable predicate that can be combined with AND/OR.
 */
export type Predicate = Readonly<{
  __expr: PredicateExpression;
  and: (other: Predicate) => Predicate;
  or: (other: Predicate) => Predicate;
  not: () => Predicate;
}>;

/**
 * Creates a predicate wrapper with chainable methods.
 */
function predicate(expr: PredicateExpression): Predicate {
  return {
    __expr: expr,
    and: (other: Predicate): Predicate =>
      predicate({
        __type: "and",
        predicates: [expr, other.__expr],
      }),
    or: (other: Predicate): Predicate =>
      predicate({
        __type: "or",
        predicates: [expr, other.__expr],
      }),
    not: (): Predicate =>
      predicate({
        __type: "not",
        predicate: expr,
      }),
  };
}

// ============================================================
// Field Builder
// ============================================================

/**
 * A typed field builder for creating predicates.
 */
type FieldBuilder<T> =
  [T] extends [string] ? StringFieldBuilder
  : [T] extends [number] ? NumberFieldBuilder
  : [T] extends [boolean] ? BooleanFieldBuilder
  : [T] extends [Date] ? DateFieldBuilder
  : [T] extends [readonly (infer U)[]] ? ArrayFieldBuilder<U>
  : [T] extends [Record<string, unknown>] ? ObjectFieldBuilder<T>
  : BaseFieldBuilder;

/**
 * Base field operations available on all types.
 */
type BaseFieldBuilder = Readonly<{
  eq: (value: unknown) => Predicate;
  neq: (value: unknown) => Predicate;
  isNull: () => Predicate;
  isNotNull: () => Predicate;
  in: (values: readonly unknown[]) => Predicate;
  notIn: (values: readonly unknown[]) => Predicate;
}>;

/**
 * String-specific field operations.
 */
type StringFieldBuilder = BaseFieldBuilder &
  Readonly<{
    contains: (pattern: string) => Predicate;
    startsWith: (pattern: string) => Predicate;
    endsWith: (pattern: string) => Predicate;
    like: (pattern: string) => Predicate;
    ilike: (pattern: string) => Predicate;
  }>;

/**
 * Number-specific field operations.
 */
type NumberFieldBuilder = BaseFieldBuilder &
  Readonly<{
    gt: (value: number) => Predicate;
    gte: (value: number) => Predicate;
    lt: (value: number) => Predicate;
    lte: (value: number) => Predicate;
    between: (lower: number, upper: number) => Predicate;
  }>;

/**
 * Boolean-specific field operations.
 */
type BooleanFieldBuilder = BaseFieldBuilder;

/**
 * Date-specific field operations.
 */
type DateFieldBuilder = BaseFieldBuilder &
  Readonly<{
    gt: (value: Date | string) => Predicate;
    gte: (value: Date | string) => Predicate;
    lt: (value: Date | string) => Predicate;
    lte: (value: Date | string) => Predicate;
    between: (lower: Date | string, upper: Date | string) => Predicate;
  }>;

type ScalarValue = string | number | boolean | Date;

type ArrayPredicateOps<T> =
  [T] extends [ScalarValue] ?
    Readonly<{
      /** Check if array contains a specific value */
      contains: (value: T) => Predicate;
      /** Check if array contains all specified values */
      containsAll: (values: readonly T[]) => Predicate;
      /** Check if array contains any of the specified values (overlaps) */
      containsAny: (values: readonly T[]) => Predicate;
    }>
  : Readonly<Record<string, never>>;

/**
 * Array-specific field operations.
 */
type ArrayFieldBuilder<T = unknown> = BaseFieldBuilder &
  Readonly<{
    /** Check if array is empty */
    isEmpty: () => Predicate;
    /** Check if array is not empty */
    isNotEmpty: () => Predicate;
    /** Check if array length equals a value */
    lengthEq: (length: number) => Predicate;
    /** Check if array length is greater than a value */
    lengthGt: (length: number) => Predicate;
    /** Check if array length is greater than or equal to a value */
    lengthGte: (length: number) => Predicate;
    /** Check if array length is less than a value */
    lengthLt: (length: number) => Predicate;
    /** Check if array length is less than or equal to a value */
    lengthLte: (length: number) => Predicate;
  }> &
  ArrayPredicateOps<T>;

/**
 * Object/JSON-specific field operations.
 */
type ResolvedPointerInput<T, Pointer> =
  Pointer extends string ? ResolveJsonPointer<T, Pointer>
  : Pointer extends readonly JsonPointerSegment[] ?
    ResolveJsonPointerSegments<T, Pointer>
  : unknown;

/**
 * Resolves the type of a nested key access on an object type.
 * Returns ObjectFieldBuilder for nested objects, FieldBuilder for scalars.
 */
type NestedFieldBuilder<T, K extends keyof T> =
  NonNullable<T[K]> extends Record<string, unknown> ?
    ObjectFieldBuilder<NonNullable<T[K]>>
  : FieldBuilder<T[K]>;

type ObjectFieldBuilder<
  T extends Record<string, unknown> = Record<string, unknown>,
> = BaseFieldBuilder &
  Readonly<{
    /** Access a nested field by key for fluent chaining */
    get: <K extends keyof T & string>(key: K) => NestedFieldBuilder<T, K>;
    /** Check if object has a specific key at root level */
    hasKey: (key: string) => Predicate;
    /** Check if object has a nested path (JSON Pointer) */
    hasPath: <P extends JsonPointerInput<T>>(pointer: P) => Predicate;
    /** Check if value at path equals a value */
    pathEquals: <P extends JsonPointerInput<T>>(
      pointer: P,
      value: string | number | boolean | Date,
    ) => Predicate;
    /** Check if value at path (array) contains a value */
    pathContains: <P extends JsonPointerInput<T>>(
      pointer: P,
      value: string | number | boolean | Date,
    ) => Predicate;
    /** Check if value at path is null */
    pathIsNull: <P extends JsonPointerInput<T>>(pointer: P) => Predicate;
    /** Check if value at path is not null */
    pathIsNotNull: <P extends JsonPointerInput<T>>(pointer: P) => Predicate;
    /** Access a nested field to get a typed field builder */
    field: <P extends JsonPointerInput<T>>(
      pointer: P,
    ) => FieldBuilder<ResolvedPointerInput<T, P>>;
  }>;

/**
 * Options for the similarTo method.
 */
export type SimilarToOptions = Readonly<{
  /** Similarity metric to use. Default: "cosine" */
  metric?: VectorMetricType;
  /**
   * Minimum similarity score to include results.
   * For cosine: 0-1 where 1 is identical.
   * For L2: maximum distance to include.
   * For inner_product: minimum inner product value.
   */
  minScore?: number;
}>;

/**
 * Embedding-specific field operations for vector similarity search.
 */
type EmbeddingFieldBuilder = BaseFieldBuilder &
  Readonly<{
    /**
     * Find nodes with similar embeddings.
     * Returns results ordered by similarity (most similar first).
     *
     * @param queryEmbedding - The embedding vector to compare against
     * @param k - Maximum number of results to return (top-k)
     * @param options - Optional configuration (metric, minScore)
     *
     * @example
     * ```typescript
     * store.query()
     *   .from("Document", "d")
     *   .whereNode("d", (d) =>
     *     d.embedding.similarTo(queryVector, 10, { metric: "cosine" })
     *   )
     *   .select((ctx) => ({ doc: ctx.d }))
     *   .execute()
     * ```
     */
    similarTo: (
      queryEmbedding: readonly number[],
      k: number,
      options?: SimilarToOptions,
    ) => Predicate;
  }>;

// ============================================================
// Field Builder Factory
// ============================================================

/**
 * Creates a field reference.
 */
type FieldRefOptions = Readonly<{
  jsonPointer?: JsonPointer | undefined;
  valueType?: ValueType | undefined;
  elementType?: ValueType | undefined;
}>;

export function fieldRef(
  alias: string,
  path: readonly string[],
  options?: FieldRefOptions,
): FieldRef {
  return {
    __type: "field_ref",
    alias,
    path,
    ...(options?.jsonPointer !== undefined && {
      jsonPointer: options.jsonPointer,
    }),
    ...(options?.valueType !== undefined && { valueType: options.valueType }),
    ...(options?.elementType !== undefined && {
      elementType: options.elementType,
    }),
  };
}

function coerceLiteralValue(value: unknown): string | number | boolean | Date {
  if (value instanceof Date) {
    return value;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  throw new Error(`Unsupported literal value type: ${typeof value}`);
}

function inferLiteralValueType(value: string | number | boolean): ValueType {
  if (typeof value === "string") {
    return "string";
  }
  if (typeof value === "number") {
    return "number";
  }
  return "boolean";
}

/**
 * Creates a literal value.
 */
function literal(value: string | number | boolean | Date): LiteralValue {
  if (value instanceof Date) {
    return { __type: "literal", value: value.toISOString(), valueType: "date" };
  }
  const valueType = inferLiteralValueType(value);
  return {
    __type: "literal",
    value,
    valueType,
  };
}

/**
 * Creates a comparison predicate.
 */
function comparison(
  op: ComparisonOp,
  field: FieldRef,
  value: unknown,
): Predicate {
  const coercedValue = coerceLiteralValue(value);
  const expr: ComparisonPredicate = {
    __type: "comparison",
    op,
    left: field,
    right: literal(coercedValue),
  };
  return predicate(expr);
}

/**
 * Creates an IN comparison predicate.
 */
function inComparison(
  op: "in" | "notIn",
  field: FieldRef,
  values: readonly unknown[],
): Predicate {
  const literals = values.map((value) => literal(coerceLiteralValue(value)));
  const expr: ComparisonPredicate = {
    __type: "comparison",
    op,
    left: field,
    right: literals,
  };
  return predicate(expr);
}

/**
 * Creates a string operation predicate.
 */
function stringOp(op: StringOp, field: FieldRef, pattern: string): Predicate {
  const expr: StringPredicate = {
    __type: "string_op",
    op,
    field,
    pattern,
  };
  return predicate(expr);
}

/**
 * Creates a null check predicate.
 */
function nullCheck(op: "isNull" | "isNotNull", field: FieldRef): Predicate {
  const expr: NullPredicate = {
    __type: "null_check",
    op,
    field,
  };
  return predicate(expr);
}

/**
 * Creates a between predicate.
 */
function between(
  field: FieldRef,
  lower: string | number | boolean | Date,
  upper: string | number | boolean | Date,
): Predicate {
  const expr: BetweenPredicate = {
    __type: "between",
    field,
    lower: literal(lower),
    upper: literal(upper),
  };
  return predicate(expr);
}

/**
 * Creates a base field builder with common operations.
 */
function baseFieldBuilder(field: FieldRef): BaseFieldBuilder {
  return {
    eq: (value) => comparison("eq", field, value),
    neq: (value) => comparison("neq", field, value),
    isNull: () => nullCheck("isNull", field),
    isNotNull: () => nullCheck("isNotNull", field),
    in: (values) => inComparison("in", field, values),
    notIn: (values) => inComparison("notIn", field, values),
  };
}

/**
 * Creates a string field builder.
 */
export function stringField(field: FieldRef): StringFieldBuilder {
  return {
    ...baseFieldBuilder(field),
    contains: (pattern) => stringOp("contains", field, pattern),
    startsWith: (pattern) => stringOp("startsWith", field, pattern),
    endsWith: (pattern) => stringOp("endsWith", field, pattern),
    like: (pattern) => stringOp("like", field, pattern),
    ilike: (pattern) => stringOp("ilike", field, pattern),
  };
}

/**
 * Creates a number field builder.
 */
export function numberField(field: FieldRef): NumberFieldBuilder {
  return {
    ...baseFieldBuilder(field),
    gt: (value) => comparison("gt", field, value),
    gte: (value) => comparison("gte", field, value),
    lt: (value) => comparison("lt", field, value),
    lte: (value) => comparison("lte", field, value),
    between: (lower, upper) => between(field, lower, upper),
  };
}

/**
 * Creates a date field builder.
 */
export function dateField(field: FieldRef): DateFieldBuilder {
  return {
    ...baseFieldBuilder(field),
    gt: (value) => comparison("gt", field, value),
    gte: (value) => comparison("gte", field, value),
    lt: (value) => comparison("lt", field, value),
    lte: (value) => comparison("lte", field, value),
    between: (lower, upper) => between(field, lower, upper),
  };
}

/**
 * Creates a base field builder (for booleans, enums, and unknown types).
 * Only provides the fundamental operations: eq, neq, isNull, isNotNull, in, notIn.
 */
export function baseField(field: FieldRef): BaseFieldBuilder {
  return baseFieldBuilder(field);
}

/**
 * Creates an array operation predicate.
 */
function arrayOp(
  op: ArrayOp,
  field: FieldRef,
  values?: readonly unknown[],
  length?: number,
): Predicate {
  const expr: ArrayPredicate = {
    __type: "array_op",
    op,
    field,
    ...(values !== undefined && {
      values: values.map((value) => literal(coerceLiteralValue(value))),
    }),
    ...(length !== undefined && { length }),
  };
  return predicate(expr);
}

/**
 * Creates an array field builder.
 */
export function arrayField<T = unknown>(field: FieldRef): ArrayFieldBuilder<T> {
  // The type assertion is needed because ArrayFieldBuilder conditionally includes
  // contains/containsAll/containsAny based on whether T extends ScalarValue.
  // At runtime we always provide them - they just won't type-check if T isn't scalar.
  return {
    ...baseFieldBuilder(field),
    contains: (value: T) => arrayOp("contains", field, [value]),
    containsAll: (values: readonly T[]) =>
      arrayOp("containsAll", field, values),
    containsAny: (values: readonly T[]) =>
      arrayOp("containsAny", field, values),
    isEmpty: () => arrayOp("isEmpty", field),
    isNotEmpty: () => arrayOp("isNotEmpty", field),
    lengthEq: (length: number) => arrayOp("lengthEq", field, undefined, length),
    lengthGt: (length: number) => arrayOp("lengthGt", field, undefined, length),
    lengthGte: (length: number) =>
      arrayOp("lengthGte", field, undefined, length),
    lengthLt: (length: number) => arrayOp("lengthLt", field, undefined, length),
    lengthLte: (length: number) =>
      arrayOp("lengthLte", field, undefined, length),
  } as unknown as ArrayFieldBuilder<T>;
}

/**
 * Creates a vector similarity predicate.
 */
function vectorSimilarity(
  field: FieldRef,
  queryEmbedding: readonly number[],
  limit: number,
  options?: SimilarToOptions,
): Predicate {
  const expr: VectorSimilarityPredicate = {
    __type: "vector_similarity",
    field,
    queryEmbedding,
    metric: options?.metric ?? "cosine",
    limit,
    ...(options?.minScore !== undefined && { minScore: options.minScore }),
  };
  return predicate(expr);
}

/**
 * Creates an embedding field builder for vector similarity search.
 */
export function embeddingField(field: FieldRef): EmbeddingFieldBuilder {
  return {
    ...baseFieldBuilder(field),
    similarTo: (queryEmbedding, k, options) =>
      vectorSimilarity(field, queryEmbedding, k, options),
  };
}

function buildFieldBuilderForTypeInfo(
  field: FieldRef,
  typeInfo: FieldTypeInfo | undefined,
): BaseFieldBuilder {
  if (!typeInfo) {
    return baseField(field);
  }

  switch (typeInfo.valueType) {
    case "string": {
      return stringField(field);
    }
    case "number": {
      return numberField(field);
    }
    case "boolean": {
      return baseField(field);
    }
    case "date": {
      return dateField(field);
    }
    case "array": {
      return arrayField(field);
    }
    case "object": {
      return objectField(field, { typeInfo });
    }
    case "embedding": {
      return embeddingField(field);
    }
    case "unknown": {
      return baseField(field);
    }
  }
}

function resolvePointerTypeInfo(
  typeInfo: FieldTypeInfo | undefined,
  pointer: JsonPointer,
): FieldTypeInfo | undefined {
  return resolveFieldTypeInfoAtJsonPointer(typeInfo, pointer);
}

/**
 * Creates an object operation predicate.
 */
type ObjectPredicateOptions = Readonly<{
  valueType?: ValueType;
  elementType?: ValueType;
}>;

function objectOp(
  op: ObjectOp,
  field: FieldRef,
  pointer: JsonPointer,
  value?: unknown,
  options?: ObjectPredicateOptions,
): Predicate {
  const expr: ObjectPredicate = {
    __type: "object_op",
    op,
    field,
    pointer,
    ...(value !== undefined && {
      value: literal(coerceLiteralValue(value)),
    }),
    ...(options?.valueType !== undefined && { valueType: options.valueType }),
    ...(options?.elementType !== undefined && {
      elementType: options.elementType,
    }),
  };
  return predicate(expr);
}

/**
 * Creates an object/JSON field builder.
 */
type ObjectFieldOptions = Readonly<{
  typeInfo?: FieldTypeInfo;
}>;

export function objectField<
  T extends Record<string, unknown> = Record<string, unknown>,
>(field: FieldRef, options?: ObjectFieldOptions): ObjectFieldBuilder<T> {
  const basePointer = field.jsonPointer;

  return {
    ...baseFieldBuilder(field),
    get: <K extends keyof T & string>(key: K) => {
      const pointer = jsonPointer([key]);
      const nestedPointer = joinJsonPointers(basePointer, pointer);
      const resolved = resolvePointerTypeInfo(options?.typeInfo, pointer);
      const nestedRef = fieldRef(field.alias, field.path, {
        jsonPointer: nestedPointer,
        ...(resolved?.valueType !== undefined && {
          valueType: resolved.valueType,
        }),
        ...(resolved?.elementType !== undefined && {
          elementType: resolved.elementType,
        }),
      });
      return buildFieldBuilderForTypeInfo(nestedRef, resolved) as ReturnType<
        ObjectFieldBuilder<T>["get"]
      >;
    },
    hasKey: (key) => {
      const pointer = jsonPointer([key]);
      resolvePointerTypeInfo(options?.typeInfo, pointer);
      return objectOp("hasKey", field, pointer);
    },
    hasPath: <P extends JsonPointerInput<T>>(pointer: P) => {
      const normalized = normalizeJsonPointer(pointer as JsonPointerInput<T>);
      resolvePointerTypeInfo(options?.typeInfo, normalized);
      return objectOp("hasPath", field, normalized);
    },
    pathEquals: <P extends JsonPointerInput<T>>(
      pointer: P,
      value: string | number | boolean | Date,
    ) => {
      const normalized = normalizeJsonPointer(pointer as JsonPointerInput<T>);
      const resolved = resolvePointerTypeInfo(options?.typeInfo, normalized);
      if (
        resolved &&
        (resolved.valueType === "array" || resolved.valueType === "object")
      ) {
        throw new Error("pathEquals is only supported for scalar JSON values");
      }
      const predicateOptions: ObjectPredicateOptions | undefined =
        resolved?.valueType === undefined ?
          undefined
        : { valueType: resolved.valueType };
      return objectOp("pathEquals", field, normalized, value, predicateOptions);
    },
    pathContains: <P extends JsonPointerInput<T>>(
      pointer: P,
      value: string | number | boolean | Date,
    ) => {
      const normalized = normalizeJsonPointer(pointer as JsonPointerInput<T>);
      const resolved = resolvePointerTypeInfo(options?.typeInfo, normalized);
      if (resolved && resolved.valueType !== "array") {
        throw new Error("pathContains is only supported for JSON array values");
      }
      const predicateOptions: ObjectPredicateOptions | undefined =
        resolved?.elementType === undefined ?
          undefined
        : { elementType: resolved.elementType };
      return objectOp(
        "pathContains",
        field,
        normalized,
        value,
        predicateOptions,
      );
    },
    pathIsNull: <P extends JsonPointerInput<T>>(pointer: P) => {
      const normalized = normalizeJsonPointer(pointer as JsonPointerInput<T>);
      const resolved = resolvePointerTypeInfo(options?.typeInfo, normalized);
      const predicateOptions: ObjectPredicateOptions | undefined =
        resolved?.valueType === undefined ?
          undefined
        : { valueType: resolved.valueType };
      return objectOp(
        "pathIsNull",
        field,
        normalized,
        undefined,
        predicateOptions,
      );
    },
    pathIsNotNull: <P extends JsonPointerInput<T>>(pointer: P) => {
      const normalized = normalizeJsonPointer(pointer as JsonPointerInput<T>);
      const resolved = resolvePointerTypeInfo(options?.typeInfo, normalized);
      const predicateOptions: ObjectPredicateOptions | undefined =
        resolved?.valueType === undefined ?
          undefined
        : { valueType: resolved.valueType };
      return objectOp(
        "pathIsNotNull",
        field,
        normalized,
        undefined,
        predicateOptions,
      );
    },
    field: <P extends JsonPointerInput<T>>(pointer: P) => {
      const normalized = normalizeJsonPointer(pointer as JsonPointerInput<T>);
      const nestedPointer = joinJsonPointers(basePointer, normalized);
      const resolved = resolvePointerTypeInfo(options?.typeInfo, normalized);
      const nestedRef = fieldRef(field.alias, field.path, {
        jsonPointer: nestedPointer,
        ...(resolved?.valueType !== undefined && {
          valueType: resolved.valueType,
        }),
        ...(resolved?.elementType !== undefined && {
          elementType: resolved.elementType,
        }),
      });
      return buildFieldBuilderForTypeInfo(nestedRef, resolved) as FieldBuilder<
        ResolvedPointerInput<T, P>
      >;
    },
  };
}

// ============================================================
// Subquery Predicates
// ============================================================

/**
 * Creates an EXISTS subquery predicate.
 * Returns true if the subquery returns at least one row.
 *
 * @param subquery - The subquery AST to check for existence
 *
 * @example
 * ```typescript
 * // Find persons who have at least one order
 * query
 *   .from("Person", "p")
 *   .whereNode("p", () =>
 *     exists(
 *       query.from("Order", "o")
 *         .whereNode("o", (o) => o.customerId.eq(field("p.id")))
 *         .select((ctx) => ({ id: ctx.o.id }))
 *         .toAst()
 *     )
 *   )
 * ```
 */
export function exists(subquery: QueryAst): Predicate {
  const expr: ExistsSubquery = {
    __type: "exists",
    subquery,
    negated: false,
  };
  return predicate(expr);
}

/**
 * Creates a NOT EXISTS subquery predicate.
 * Returns true if the subquery returns no rows.
 *
 * @param subquery - The subquery AST to check for non-existence
 */
export function notExists(subquery: QueryAst): Predicate {
  const expr: ExistsSubquery = {
    __type: "exists",
    subquery,
    negated: true,
  };
  return predicate(expr);
}

/**
 * Creates an IN subquery predicate.
 * Returns true if the field value is in the subquery results.
 *
 * @param field - The field to check
 * @param subquery - The subquery AST that returns a single column
 *
 * @example
 * ```typescript
 * // Find persons whose ID is in the VIP list
 * query
 *   .from("Person", "p")
 *   .where(() =>
 *     inSubquery(
 *       fieldRef("p", ["id"]),
 *       query.from("VIPMember", "v")
 *         .select({ id: field("v.personId") })
 *         .toAst()
 *     )
 *   )
 * ```
 */
export function inSubquery(field: FieldRef, subquery: QueryAst): Predicate {
  const expr: InSubquery = {
    __type: "in_subquery",
    field,
    subquery,
    negated: false,
  };
  return predicate(expr);
}

/**
 * Creates a NOT IN subquery predicate.
 * Returns true if the field value is not in the subquery results.
 *
 * @param field - The field to check
 * @param subquery - The subquery AST that returns a single column
 */
export function notInSubquery(field: FieldRef, subquery: QueryAst): Predicate {
  const expr: InSubquery = {
    __type: "in_subquery",
    field,
    subquery,
    negated: true,
  };
  return predicate(expr);
}
