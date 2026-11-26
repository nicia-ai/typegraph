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
import { CompilerInvariantError } from "../../errors";
import { requireDefined } from "../../utils/presence";
import {
  type FieldRef,
  type LiteralValue,
  type NodePredicate,
  type OrderSpec,
  type PredicateExpression,
  type RelevanceComparisonPredicate,
  type TupleComparisonPredicate,
} from "../ast";
import { isNullableSystemOrderField } from "../builder/order-by-field";
import type {
  AliasMap,
  EdgeAliasMap,
  PaginatedResult,
  PaginateOptions,
  SelectContext,
  StreamOptions,
} from "../builder/types";
import { type RelevanceSortKey } from "../compiler/relevance-order";
import { requireCursorField } from "../cursor";
import {
  buildCursorFromRow,
  type CursorData,
  decodeCursor,
  type KeysetKey,
  validateCursorColumns,
} from "../cursor";
import { resolveNullOrdering, reverseOrder } from "../order";

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
  return orderBy.map((spec) => reverseOrder(spec));
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
  const tupleComparison = buildTupleComparisonPredicate(
    cursorData.vals,
    orderBy,
    direction,
  );
  if (tupleComparison !== undefined) {
    return { targetAlias, expression: tupleComparison };
  }
  return {
    targetAlias,
    expression: buildKeysetPosition(
      cursorData.vals,
      orderBy.map((spec) => ({ kind: "field", spec }) as const),
      direction,
    ),
  };
}

/**
 * "Strictly after (or before) the cursor" over `keys` in order: the OR of
 * progressively longer ANDs, each holding the keys before one key equal to
 * the cursor's values and that key past its value. The one owner of the
 * lexicographic keyset position, for field and relevance keys alike.
 */
function buildKeysetPosition(
  values: readonly unknown[],
  keys: readonly KeysetKey[],
  direction: "forward" | "backward",
): PredicateExpression {
  const position = direction === "forward" ? "after" : "before";
  const orConditions: PredicateExpression[] = [];

  for (const [index, currentKey] of keys.entries()) {
    const comparison = buildKeyPositionPredicate(
      currentKey,
      values[index],
      position,
    );
    if (comparison === undefined) continue;
    // All preceding keys must be equal
    const andConditions = [
      ...keys
        .slice(0, index)
        .map((key, keyIndex) =>
          buildKeyEqualityPredicate(key, values[keyIndex]),
        ),
      comparison,
    ];
    orConditions.push(
      andConditions.length === 1 ?
        requireDefined(andConditions[0])
      : { __type: "and", predicates: andConditions },
    );
  }

  if (orConditions.length === 0) {
    // Only a NULL field key can leave nothing past the cursor; a relevance
    // key always has a value to compare.
    const firstField = keys.find((key) => key.kind === "field");
    return buildImpossiblePredicate(
      requireCursorField(requireDefined(firstField).spec.field),
    );
  }
  return orConditions.length === 1 ?
      requireDefined(orConditions[0])
    : { __type: "or", predicates: orConditions };
}

function buildKeyEqualityPredicate(
  key: KeysetKey,
  value: unknown,
): PredicateExpression {
  if (key.kind === "field")
    return buildEqualityPredicate(requireCursorField(key.spec.field), value);
  return buildRelevanceComparison(key.key, "eq", value);
}

function buildKeyPositionPredicate(
  key: KeysetKey,
  value: unknown,
  position: "after" | "before",
): PredicateExpression | undefined {
  if (key.kind === "field")
    return buildPositionPredicate(
      requireCursorField(key.spec.field),
      key.spec,
      value,
      position,
    );
  const isAscending = key.key.direction === "asc";
  return buildRelevanceComparison(
    key.key,
    isAscending === (position === "after") ? "gt" : "lt",
    value,
  );
}

function buildRelevanceComparison(
  key: RelevanceSortKey,
  op: RelevanceComparisonPredicate["op"],
  value: unknown,
): RelevanceComparisonPredicate {
  if (typeof value !== "string" && typeof value !== "number")
    throw new CompilerInvariantError(
      `A cursor reached the keyset without a value for the ${key.source} relevance key`,
      { phase: "relevance-cursor-key" },
    );
  return { __type: "relevance_comparison", source: key.source, op, value };
}

/**
 * Applies a cursor to a full-text, vector or hybrid query: the keyset
 * position over `keys` (`describeSelectionOrder`, relevance keys included) is
 * ANDed into the completed-match predicate, after the relevance relations are
 * computed. It never filters a node alias: the start alias's rows are the
 * candidates the search ranks and limits to its top k, so a position pushed
 * into them would rank a different candidate set on every page.
 */
export function applyRelevanceCursorFilter(
  resultPredicate: PredicateExpression | undefined,
  values: readonly unknown[],
  keys: readonly KeysetKey[],
  direction: "forward" | "backward",
): PredicateExpression {
  const position = buildKeysetPosition(values, keys, direction);
  return resultPredicate === undefined ? position : (
      { __type: "and", predicates: [resultPredicate, position] }
    );
}

/** The parts of a query a cursor is applied to. */
type CursorFilterTarget = Readonly<{
  startAlias: string;
  /**
   * Whether the cursor is a property of the completed match row rather than
   * of the start node alone — see {@link applyCursorFilters}.
   */
  positionsCompletedMatch: boolean;
  predicates: readonly NodePredicate[];
  resultPredicate?: PredicateExpression | undefined;
}>;

/** A query's filters with one page's cursor applied. */
type CursorFilters = Readonly<{
  predicates: readonly NodePredicate[];
  resultPredicate: PredicateExpression | undefined;
}>;

/**
 * Applies a cursor to a query: WHERE the keyset position is tested.
 *
 * A node predicate is compiled against its target alias alone, so it can
 * only carry a cursor whose every key reads that alias — the start alias of a
 * query with no traversal. Once a traversal is present the keyset names
 * traversal aliases too (the caller's own order keys, and the row-identity
 * tiebreaker), and the position is a property of the COMPLETED match row. It
 * is then applied as the completed-match predicate, which resolves every
 * alias, ANDed with any `where()` the caller stated.
 *
 * For a traversal query the leading keys that read the start alias are also
 * pushed into the start alias's own filter, non-strictly ("at or after the
 * cursor's start row"): every row strictly after the cursor satisfies it, and
 * it keeps a page from re-reading every start row before the cursor.
 */
export function applyCursorFilters(
  target: CursorFilterTarget,
  cursorData: CursorData,
  orderBy: readonly OrderSpec[],
  direction: "forward" | "backward",
): CursorFilters {
  const position = buildCursorPredicate(
    cursorData,
    orderBy,
    direction,
    target.startAlias,
  );
  if (!target.positionsCompletedMatch) {
    return {
      predicates: [...target.predicates, position],
      resultPredicate: target.resultPredicate,
    };
  }
  const startPrefix = buildStartPrefixPredicate(
    cursorData,
    orderBy,
    direction,
    target.startAlias,
  );
  return {
    predicates:
      startPrefix === undefined ?
        target.predicates
      : [...target.predicates, startPrefix],
    resultPredicate:
      target.resultPredicate === undefined ?
        position.expression
      : {
          __type: "and",
          predicates: [target.resultPredicate, position.expression],
        },
  };
}

/**
 * "At or after the cursor" over the leading order keys that read the start
 * alias: strictly after on that prefix, or equal on all of it. `undefined`
 * when the first key reads another alias, which leaves nothing to push down.
 */
function buildStartPrefixPredicate(
  cursorData: CursorData,
  orderBy: readonly OrderSpec[],
  direction: "forward" | "backward",
  startAlias: string,
): NodePredicate | undefined {
  const firstOtherAlias = orderBy.findIndex(
    (spec) => requireCursorField(spec.field).alias !== startAlias,
  );
  const prefixLength =
    firstOtherAlias === -1 ? orderBy.length : firstOtherAlias;
  if (prefixLength === 0) return undefined;
  const prefixOrderBy = orderBy.slice(0, prefixLength);
  const prefixValues = cursorData.vals.slice(0, prefixLength);
  const strictlyAfter = buildCursorPredicate(
    { ...cursorData, vals: prefixValues },
    prefixOrderBy,
    direction,
    startAlias,
  ).expression;
  const equalities = prefixOrderBy.map((spec, index) =>
    buildEqualityPredicate(requireCursorField(spec.field), prefixValues[index]),
  );
  return {
    targetAlias: startAlias,
    expression: {
      __type: "or",
      predicates: [strictlyAfter, { __type: "and", predicates: equalities }],
    },
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
    !isNullableSystemOrderField(requireDefined(field.path[0])) &&
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
