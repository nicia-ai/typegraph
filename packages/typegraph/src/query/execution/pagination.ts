/**
 * Cursor-based pagination utilities.
 *
 * Provides pagination logic for ExecutableQuery including cursor predicate
 * building and result page construction.
 */
import {
  DEFAULT_PAGINATION_LIMIT,
  DEFAULT_STREAM_BATCH_SIZE,
} from "../../constants";
import { requireDefined } from "../../utils/presence";
import {
  type FieldRef,
  type LiteralValue,
  type NodePredicate,
  type OrderSpec,
  type PredicateExpression,
  type TupleComparisonPredicate,
} from "../ast";
import type {
  AliasMap,
  EdgeAliasMap,
  PaginatedResult,
  PaginateOptions,
  SelectContext,
  StreamOptions,
} from "../builder/types";
import { requireCursorField } from "../cursor";
import {
  buildCursorFromRow,
  type CursorData,
  decodeCursor,
  validateCursorColumns,
} from "../cursor";
import { resolveNullOrdering } from "../order";

/**
 * Parses pagination options into internal format.
 */
export function parsePaginateOptions(options: PaginateOptions): {
  isBackward: boolean;
  limit: number;
  cursor: string | undefined;
  cursorData: CursorData | undefined;
  orderBy: readonly OrderSpec[];
} {
  const isBackward = options.last !== undefined || options.before !== undefined;
  const limit = options.first ?? options.last ?? DEFAULT_PAGINATION_LIMIT;
  const cursor = options.after ?? options.before;

  let cursorData: CursorData | undefined;
  if (cursor) {
    cursorData = decodeCursor(cursor);
  }

  return { isBackward, limit, cursor, cursorData, orderBy: [] };
}

/**
 * Validates cursor data against ORDER BY columns.
 */
export function validateCursor(
  cursorData: CursorData | undefined,
  orderBy: readonly OrderSpec[],
): void {
  if (cursorData) {
    validateCursorColumns(cursorData, orderBy);
  }
}

/**
 * Adjusts ORDER BY for backward pagination (reverses directions).
 */
export function adjustOrderByForDirection(
  orderBy: readonly OrderSpec[],
  direction: "forward" | "backward",
): readonly OrderSpec[] {
  if (direction === "forward") {
    return orderBy;
  }
  return orderBy.map((spec) => ({
    ...spec,
    direction: spec.direction === "asc" ? ("desc" as const) : ("asc" as const),
    nulls: resolveNullOrdering(spec) === "first" ? "last" : "first",
  }));
}

/**
 * Builds a cursor predicate for keyset pagination.
 * Generates (col1 > val1) OR (col1 = val1 AND col2 > val2) OR ... pattern.
 */
export function buildCursorPredicate(
  cursorData: CursorData,
  orderBy: readonly OrderSpec[],
  direction: "forward" | "backward",
  targetAlias: string,
): NodePredicate {
  const values = cursorData.vals;

  const tupleComparison = buildTupleComparisonPredicate(
    values,
    orderBy,
    direction,
  );
  if (tupleComparison !== undefined) {
    return { targetAlias, expression: tupleComparison };
  }

  // Build OR of progressively longer AND conditions
  const orConditions: PredicateExpression[] = [];

  for (let index = 0; index < orderBy.length; index++) {
    const andConditions: PredicateExpression[] = [];

    // All preceding columns must be equal
    for (let index_ = 0; index_ < index; index_++) {
      const spec = requireDefined(orderBy[index_]);
      const value = values[index_];
      andConditions.push(
        buildEqualityPredicate(requireCursorField(spec.field), value),
      );
    }

    // Current column uses comparison
    const currentSpec = requireDefined(orderBy[index]);
    const comparison = buildPositionPredicate(
      requireCursorField(currentSpec.field),
      currentSpec,
      values[index],
      direction === "forward" ? "after" : "before",
    );
    if (comparison === undefined) continue;
    andConditions.push(comparison);

    // Combine with AND
    if (andConditions.length === 1) {
      orConditions.push(requireDefined(andConditions[0]));
    } else {
      orConditions.push({ __type: "and", predicates: andConditions });
    }
  }

  // Combine with OR
  const expression: PredicateExpression =
    orConditions.length === 0 ?
      buildImpossiblePredicate(
        requireCursorField(requireDefined(orderBy[0]).field),
      )
    : orConditions.length === 1 ? requireDefined(orConditions[0])
    : { __type: "or", predicates: orConditions };

  return {
    targetAlias,
    expression,
  };
}

/** Uses row values only when SQL NULL semantics cannot change the ordering. */
function buildTupleComparisonPredicate(
  values: readonly unknown[],
  orderBy: readonly OrderSpec[],
  direction: "forward" | "backward",
): TupleComparisonPredicate | undefined {
  if (orderBy.length < 2 || values.length !== orderBy.length) return;
  const [first] = orderBy;
  if (first === undefined) return;
  if (
    orderBy.some(
      (spec, index) =>
        spec.direction !== first.direction ||
        spec.nulls !== undefined ||
        !isTupleComparableField(spec.field) ||
        values[index] === null ||
        values[index] === undefined,
    )
  ) {
    return;
  }
  const fields = orderBy.map((spec) => requireCursorField(spec.field)) as [
    FieldRef,
    ...FieldRef[],
  ];
  const tupleValues = values.map((value) => ({
    __type: "literal" as const,
    value: value as string | number | boolean,
  })) as [LiteralValue, ...LiteralValue[]];
  const afterAscending =
    (direction === "forward" && first.direction === "asc") ||
    (direction === "backward" && first.direction === "desc");
  return {
    __type: "tuple_comparison",
    fields,
    op: afterAscending ? "gt" : "lt",
    values: tupleValues,
  };
}

function isTupleComparableField(field: OrderSpec["field"]): boolean {
  if (field.__type !== "field_ref") return false;
  if (field.nullable === true) return false;
  if (field.nullable === false) return isTupleScalarValueType(field.valueType);
  // System identity and creation columns are physically NOT NULL. Existing
  // manually assembled ASTs may predate the nullable marker, so retain this
  // narrow compatibility path without making user properties eligible.
  return (
    field.path.length === 1 &&
    isTupleScalarValueType(field.valueType) &&
    ["id", "kind", "created_at", "updated_at"].includes(
      requireDefined(field.path[0]),
    )
  );
}

function isTupleScalarValueType(valueType: FieldRef["valueType"]): boolean {
  return (
    valueType === "boolean" ||
    valueType === "date" ||
    valueType === "number" ||
    valueType === "string"
  );
}

/**
 * Builds an equality predicate for cursor pagination.
 */
function buildEqualityPredicate(
  field: FieldRef,
  value: unknown,
): PredicateExpression {
  if (value === null || value === undefined) {
    return { __type: "null_check", op: "isNull", field };
  }
  return {
    __type: "comparison",
    op: "eq",
    left: field,
    right: { __type: "literal", value: value as string | number | boolean },
  };
}

/**
 * Builds a comparison predicate for cursor pagination.
 */
function buildPositionPredicate(
  field: FieldRef,
  spec: OrderSpec,
  value: unknown,
  position: "after" | "before",
): PredicateExpression | undefined {
  const nulls = resolveNullOrdering(spec);
  if (value === null || value === undefined) {
    const nonNullValuesMatch =
      (position === "after" && nulls === "first") ||
      (position === "before" && nulls === "last");
    return nonNullValuesMatch ?
        { __type: "null_check", op: "isNotNull", field }
      : undefined;
  }

  const isAscending = spec.direction === "asc";
  const comparison: PredicateExpression = {
    __type: "comparison",
    op: isAscending === (position === "after") ? "gt" : "lt",
    left: field,
    right: { __type: "literal", value: value as string | number | boolean },
  };
  const nullValuesMatch =
    (position === "after" && nulls === "last") ||
    (position === "before" && nulls === "first");
  return nullValuesMatch ?
      {
        __type: "or",
        predicates: [comparison, { __type: "null_check", op: "isNull", field }],
      }
    : comparison;
}

function buildImpossiblePredicate(field: FieldRef): PredicateExpression {
  return {
    __type: "and",
    predicates: [
      { __type: "null_check", op: "isNull", field },
      { __type: "null_check", op: "isNotNull", field },
    ],
  };
}

/**
 * Builds cursor string from a context row.
 */
export function buildCursorFromContext<
  Aliases extends AliasMap,
  EdgeAliases extends EdgeAliasMap,
>(
  context: SelectContext<Aliases, EdgeAliases>,
  orderBy: readonly OrderSpec[],
  direction: "f" | "b",
): string {
  return buildCursorFromRow(context, orderBy, direction);
}

/**
 * Constructs a PaginatedResult from query results.
 */
export function buildPaginatedResult<
  Aliases extends AliasMap,
  EdgeAliases extends EdgeAliasMap,
  R,
>(
  data: readonly R[],
  orderedRows: readonly Record<string, unknown>[],
  orderBy: readonly OrderSpec[],
  limit: number,
  hasMore: boolean,
  isBackward: boolean,
  cursor: string | undefined,
  buildContext: (
    row: Record<string, unknown>,
  ) => SelectContext<Aliases, EdgeAliases>,
): PaginatedResult<R> {
  let nextCursor: string | undefined;
  let previousCursor: string | undefined;

  if (orderedRows.length > 0) {
    const firstRow = requireDefined(orderedRows[0]);
    const lastRow = requireDefined(orderedRows.at(-1));

    // Build cursors using mapped result context
    const firstContext = buildContext(firstRow);
    const lastContext = buildContext(lastRow);

    // Extract values for ORDER BY columns from the context
    previousCursor = buildCursorFromContext(firstContext, orderBy, "b");
    nextCursor = buildCursorFromContext(lastContext, orderBy, "f");
  }

  return {
    data,
    nextCursor: hasMore || isBackward ? nextCursor : undefined,
    prevCursor:
      cursor !== undefined || (isBackward && hasMore) ?
        previousCursor
      : undefined,
    hasNextPage: isBackward ? cursor !== undefined : hasMore,
    hasPrevPage: isBackward ? hasMore : cursor !== undefined,
  };
}

/**
 * Creates an async iterable that streams results using cursor pagination.
 */
export async function* createStreamIterable<R>(
  batchSize: number,
  paginate: (options: PaginateOptions) => Promise<PaginatedResult<R>>,
): AsyncGenerator<R> {
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const options: PaginateOptions =
      cursor ? { first: batchSize, after: cursor } : { first: batchSize };
    const page = await paginate(options);

    for (const item of page.data) {
      yield item;
    }

    cursor = page.nextCursor;
    hasMore = page.hasNextPage;
  }
}

/**
 * Gets default stream options.
 */
export function getStreamBatchSize(options?: StreamOptions): number {
  return options?.batchSize ?? DEFAULT_STREAM_BATCH_SIZE;
}
