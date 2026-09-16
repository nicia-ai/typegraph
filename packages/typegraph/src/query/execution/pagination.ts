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
  type NodePredicate,
  type OrderSpec,
  type PredicateExpression,
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
  return buildPaginatedResultFromRows(
    data,
    orderedRows,
    hasMore,
    isBackward,
    cursor,
    (row, direction) =>
      buildCursorFromContext(buildContext(row), orderBy, direction),
  );
}

/**
 * Constructs a paginated result from rows and a caller-owned cursor encoder.
 */
export function buildPaginatedResultFromRows<R, Row>(
  data: readonly R[],
  orderedRows: readonly Row[],
  hasMore: boolean,
  isBackward: boolean,
  cursor: string | undefined,
  buildCursor: (row: Row, direction: "f" | "b") => string,
): PaginatedResult<R> {
  const firstRow = orderedRows[0];
  const lastRow = orderedRows.at(-1);
  const previousCursor =
    firstRow === undefined ? undefined : buildCursor(firstRow, "b");
  const nextCursor =
    lastRow === undefined ? undefined : buildCursor(lastRow, "f");

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
