/**
 * Cursor-based pagination utilities.
 *
 * Provides pagination logic for ExecutableQuery including cursor predicate
 * building and result page construction.
 */
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
import {
  buildCursorFromRow,
  type CursorData,
  decodeCursor,
  validateCursorColumns,
} from "../cursor";

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
  const limit = options.first ?? options.last ?? 20;
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
      const spec = orderBy[index_]!;
      const value = values[index_];
      andConditions.push(buildEqualityPredicate(spec.field, value));
    }

    // Current column uses comparison
    const currentSpec = orderBy[index]!;
    const currentValue = values[index];
    const isAsc = currentSpec.direction === "asc";
    const isForward = direction === "forward";
    // ASC + forward = gt | ASC + backward = lt
    // DESC + forward = lt | DESC + backward = gt
    const op = isAsc === isForward ? "gt" : "lt";

    andConditions.push(
      buildComparisonPredicate(currentSpec.field, op, currentValue),
    );

    // Combine with AND
    if (andConditions.length === 1) {
      orConditions.push(andConditions[0]!);
    } else {
      orConditions.push({ __type: "and", predicates: andConditions });
    }
  }

  // Combine with OR
  const expression: PredicateExpression =
    orConditions.length === 1 ?
      orConditions[0]!
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
function buildComparisonPredicate(
  field: FieldRef,
  op: "gt" | "lt",
  value: unknown,
): PredicateExpression {
  if (value === null || value === undefined) {
    // For null, the comparison depends on NULLS FIRST/LAST behavior
    // For simplicity, treat as IS NOT NULL for forward, fail for backward
    return { __type: "null_check", op: "isNotNull", field };
  }
  return {
    __type: "comparison",
    op,
    left: field,
    right: { __type: "literal", value: value as string | number | boolean },
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
  return buildCursorFromRow(
    context as unknown as Record<string, unknown>,
    orderBy,
    direction,
  );
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
    const firstRow = orderedRows[0]!;
    const lastRow = orderedRows.at(-1)!;

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
  return options?.batchSize ?? 1000;
}
