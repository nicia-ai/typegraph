/**
 * ExecutableQuery - A query that can be executed, paginated, or streamed.
 */
import { type SQL } from "drizzle-orm";

import { type GraphDef } from "../../core/define-graph";
import { ValidationError } from "../../errors";
import {
  type OrderSpec,
  type QueryAst,
  type SelectiveField,
  type SortDirection,
} from "../ast";
import { compileQuery, type CompileQueryOptions } from "../compiler/index";
import {
  buildCursorFromRow,
  type CursorData,
  decodeCursor,
  validateCursorColumns,
} from "../cursor";
import {
  buildCursorPredicate,
  buildPaginatedResult,
  buildSelectContext,
  buildSelectiveFields,
  createStreamIterable,
  createTrackingContext,
  decodeSelectedValue,
  FieldAccessTracker,
  getStreamBatchSize,
  mapResults,
  mapSelectiveResults,
  MissingSelectiveFieldError,
  transformPathColumns,
} from "../execution";
import { jsonPointer, parseJsonPointer } from "../json-pointer";
import { fieldRef } from "../predicates";
import { buildQueryAst } from "./ast-builder";
import {
  type AliasMap,
  type EdgeAliasMap,
  type PaginatedResult,
  type PaginateOptions,
  type QueryBuilderConfig,
  type QueryBuilderState,
  type SelectContext,
  type StreamOptions,
} from "./types";
import { type UnionableQuery } from "./unionable-query";

const NOT_COMPUTED = Symbol("NOT_COMPUTED");

// Forward declaration for UnionableQuery to avoid circular imports
type UnionableQueryConstructor = new (
  config: QueryBuilderConfig,
  state: {
    left: QueryAst;
    operator: "union" | "unionAll" | "intersect" | "except";
    right: QueryAst;
    // Additional state for result transformation
    startAlias: string;
    traversals: QueryBuilderState["traversals"];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Allow any select function type for set operations
    selectFn: (context: SelectContext<any, any>) => unknown;
  },
) => unknown;

let UnionableQueryClass: UnionableQueryConstructor;

/**
 * Sets the UnionableQuery class reference.
 * Called during module initialization to break circular dependency.
 */
export function setUnionableQueryClass(cls: UnionableQueryConstructor): void {
  UnionableQueryClass = cls;
}

/**
 * A query that can be executed.
 */
export class ExecutableQuery<
  G extends GraphDef,
  Aliases extends AliasMap,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Empty object for initial empty edge alias map
  EdgeAliases extends EdgeAliasMap = {},
  R = unknown,
> {
  readonly #config: QueryBuilderConfig;
  readonly #state: QueryBuilderState;
  readonly #selectFn: (context: SelectContext<Aliases, EdgeAliases>) => R;
  #cachedSelectiveFieldsForExecute:
    | readonly SelectiveField[]
    | typeof NOT_COMPUTED
    | undefined = NOT_COMPUTED;
  #cachedSelectiveFieldsForPagination:
    | readonly SelectiveField[]
    | typeof NOT_COMPUTED
    | undefined = NOT_COMPUTED;

  constructor(
    config: QueryBuilderConfig,
    state: QueryBuilderState,
    selectFunction: (context: SelectContext<Aliases, EdgeAliases>) => R,
  ) {
    this.#config = config;
    this.#state = state;
    this.#selectFn = selectFunction;
  }

  /**
   * Builds the query AST.
   */
  toAst(): QueryAst {
    return buildQueryAst(this.#config, this.#state);
  }

  /**
   * Orders results.
   */
  orderBy<A extends keyof Aliases & string>(
    alias: A,
    field: string,
    direction: SortDirection = "asc",
  ): ExecutableQuery<G, Aliases, EdgeAliases, R> {
    const kindNames =
      alias === this.#state.startAlias ?
        this.#state.startKinds
      : this.#state.traversals.find(
          (traversal) => traversal.nodeAlias === alias,
        )?.nodeKinds;
    const typeInfo =
      kindNames ?
        this.#config.schemaIntrospector.getSharedFieldTypeInfo(kindNames, field)
      : undefined;

    const orderSpec: OrderSpec = {
      field: fieldRef(alias, ["props"], {
        jsonPointer: jsonPointer([field]),
        valueType: typeInfo?.valueType,
        elementType: typeInfo?.elementType,
      }),
      direction,
    };

    const newState: QueryBuilderState = {
      ...this.#state,
      orderBy: [...this.#state.orderBy, orderSpec],
    };

    return new ExecutableQuery(this.#config, newState, this.#selectFn);
  }

  /**
   * Limits the number of results.
   */
  limit(n: number): ExecutableQuery<G, Aliases, EdgeAliases, R> {
    return new ExecutableQuery(
      this.#config,
      { ...this.#state, limit: n },
      this.#selectFn,
    );
  }

  /**
   * Offsets the results.
   */
  offset(n: number): ExecutableQuery<G, Aliases, EdgeAliases, R> {
    return new ExecutableQuery(
      this.#config,
      { ...this.#state, offset: n },
      this.#selectFn,
    );
  }

  /**
   * Applies a query fragment to transform this executable query.
   *
   * Useful for applying post-select transformations like ordering,
   * limits, and offsets from reusable fragments.
   *
   * @example
   * ```typescript
   * const paginated = (q) => q.orderBy("u", "createdAt", "desc").limit(10);
   *
   * const results = await query()
   *   .from("User", "u")
   *   .select((ctx) => ctx.u)
   *   .pipe(paginated)
   *   .execute();
   * ```
   *
   * @param fragment - A function that transforms the executable query
   * @returns The transformed executable query
   */
  pipe<NewR = R>(
    fragment: (
      query: ExecutableQuery<G, Aliases, EdgeAliases, R>,
    ) => ExecutableQuery<G, Aliases, EdgeAliases, NewR>,
  ): ExecutableQuery<G, Aliases, EdgeAliases, NewR> {
    return fragment(this);
  }

  /**
   * Combines this query with another using UNION (removes duplicates).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Allow any alias map for set operations
  union(other: ExecutableQuery<G, any, any, R>): UnionableQuery<G, R> {
    return new UnionableQueryClass(this.#config, {
      left: this.toAst(),
      operator: "union",
      right: other.toAst(),
      // Pass state for result transformation
      startAlias: this.#state.startAlias,
      traversals: this.#state.traversals,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Type erasure for set operations
      selectFn: this.#selectFn as (context: SelectContext<any, any>) => unknown,
    }) as UnionableQuery<G, R>;
  }

  /**
   * Combines this query with another using UNION ALL (keeps duplicates).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Allow any alias map for set operations
  unionAll(other: ExecutableQuery<G, any, any, R>): UnionableQuery<G, R> {
    return new UnionableQueryClass(this.#config, {
      left: this.toAst(),
      operator: "unionAll",
      right: other.toAst(),
      // Pass state for result transformation
      startAlias: this.#state.startAlias,
      traversals: this.#state.traversals,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Type erasure for set operations
      selectFn: this.#selectFn as (context: SelectContext<any, any>) => unknown,
    }) as UnionableQuery<G, R>;
  }

  /**
   * Combines this query with another using INTERSECT.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Allow any alias map for set operations
  intersect(other: ExecutableQuery<G, any, any, R>): UnionableQuery<G, R> {
    return new UnionableQueryClass(this.#config, {
      left: this.toAst(),
      operator: "intersect",
      right: other.toAst(),
      // Pass state for result transformation
      startAlias: this.#state.startAlias,
      traversals: this.#state.traversals,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Type erasure for set operations
      selectFn: this.#selectFn as (context: SelectContext<any, any>) => unknown,
    }) as UnionableQuery<G, R>;
  }

  /**
   * Combines this query with another using EXCEPT.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Allow any alias map for set operations
  except(other: ExecutableQuery<G, any, any, R>): UnionableQuery<G, R> {
    return new UnionableQueryClass(this.#config, {
      left: this.toAst(),
      operator: "except",
      right: other.toAst(),
      // Pass state for result transformation
      startAlias: this.#state.startAlias,
      traversals: this.#state.traversals,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Type erasure for set operations
      selectFn: this.#selectFn as (context: SelectContext<any, any>) => unknown,
    }) as UnionableQuery<G, R>;
  }

  /**
   * Compiles the query to a Drizzle SQL object.
   *
   * Returns a Drizzle SQL object that can be executed directly
   * with db.all(), db.get(), etc.
   */
  compile(): SQL {
    const ast = this.toAst();
    return compileQuery(ast, this.#config.graphId, this.#compileOptions());
  }

  /**
   * Builds compile options from the config.
   */
  #compileOptions(): CompileQueryOptions {
    return {
      dialect: this.#config.dialect ?? "sqlite",
      schema: this.#config.schema,
    };
  }

  /**
   * Executes the query and returns typed results.
   *
   * Uses smart optimization to detect when only specific fields are accessed
   * in the select callback. If the callback only accesses simple field
   * references (no method calls or computations), generates optimized SQL
   * that only extracts those fields instead of the full props blob.
   *
   * @throws Error if no backend is configured
   */
  async execute(): Promise<readonly R[]> {
    if (!this.#config.backend) {
      throw new Error(
        "Cannot execute query: no backend configured. " +
          "Use store.query() or pass a backend to createQueryBuilder().",
      );
    }

    // Phase 1: Try optimized execution
    const optimizedResult = await this.#tryOptimizedExecution();
    if (optimizedResult !== undefined) {
      return optimizedResult;
    }

    // Phase 2: Fall back to full fetch (existing behavior)
    const compiled = this.compile();
    const rawRows =
      await this.#config.backend.execute<Record<string, unknown>>(compiled);

    // Transform path columns for SQLite (converts "|id1|id2|" to ["id1", "id2"])
    const dialect = this.#config.dialect ?? "sqlite";
    const rows = transformPathColumns(rawRows, this.#state, dialect);

    return mapResults(
      rows,
      this.#state.startAlias,
      this.#state.traversals,
      this.#selectFn,
    );
  }

  /**
   * Attempts optimized execution by tracking which fields the select callback accesses.
   *
   * Returns undefined if optimization is not possible (callback uses method calls,
   * computations, or returns whole nodes).
   */
  async #tryOptimizedExecution(): Promise<readonly R[] | undefined> {
    // Skip optimization for variable-length traversals
    // The recursive query compiler doesn't support selectiveFields
    const hasVariableLength = this.#state.traversals.some(
      (t) => t.variableLength !== undefined,
    );
    if (hasVariableLength) {
      return undefined;
    }

    const selectiveFields = this.#getSelectiveFieldsForExecute();
    if (selectiveFields === undefined) {
      return undefined;
    }

    // Build and compile optimized query
    const baseAst = buildQueryAst(this.#config, this.#state);
    const selectiveAst = {
      ...baseAst,
      selectiveFields,
    };

    const compiled = compileQuery(
      selectiveAst,
      this.#config.graphId,
      this.#compileOptions(),
    );
    const rows =
      await this.#config.backend!.execute<Record<string, unknown>>(compiled);

    try {
      return mapSelectiveResults<Aliases, EdgeAliases, R>(
        rows,
        this.#state,
        selectiveFields,
        this.#config.schemaIntrospector,
        this.#selectFn,
      );
    } catch (error) {
      if (error instanceof MissingSelectiveFieldError) {
        this.#cachedSelectiveFieldsForExecute = undefined;
        return undefined;
      }
      throw error;
    }
  }

  #trackSelectFunctionAccesses(tracker: FieldAccessTracker): void {
    const hasOptionalTraversal = this.#state.traversals.some(
      (traversal) => traversal.optional,
    );

    const trackingRuns =
      hasOptionalTraversal ?
        ([
          {
            mode: "truthy" as const,
            optionalTraversalAliases: "present" as const,
          },
          {
            mode: "falsy" as const,
            optionalTraversalAliases: "present" as const,
          },
          {
            mode: "falsy" as const,
            optionalTraversalAliases: "absent" as const,
          },
        ] as const)
      : ([
          {
            mode: "truthy" as const,
            optionalTraversalAliases: "present" as const,
          },
          {
            mode: "falsy" as const,
            optionalTraversalAliases: "present" as const,
          },
        ] as const);

    for (const run of trackingRuns) {
      const trackingContext = createTrackingContext(this.#state, tracker, {
        schemaIntrospector: this.#config.schemaIntrospector,
        mode: run.mode,
        optionalTraversalAliases: run.optionalTraversalAliases,
      });

      try {
        // Execute the select callback against a lightweight tracking context.
        // We intentionally ignore the return value: we only need accessed fields.
        void this.#selectFn(
          trackingContext as SelectContext<Aliases, EdgeAliases>,
        );
      } catch {
        // Best-effort tracking: any runtime errors in the callback (e.g. calling
        // a method on an undefined optional field) should simply disable or
        // reduce optimization, never change correctness.
      }
    }
  }

  #getSelectiveFieldsForExecute(): readonly SelectiveField[] | undefined {
    if (this.#cachedSelectiveFieldsForExecute === undefined) {
      return undefined;
    }

    if (this.#cachedSelectiveFieldsForExecute !== NOT_COMPUTED) {
      return this.#cachedSelectiveFieldsForExecute;
    }

    const tracker = new FieldAccessTracker();
    this.#trackSelectFunctionAccesses(tracker);

    const accessed = tracker.getAccessedFields();
    if (accessed.length === 0) {
      this.#cachedSelectiveFieldsForExecute = undefined;
      return undefined;
    }

    const selectiveFields = this.#ensureOptionalTraversalIdsSelected(
      buildSelectiveFields(accessed, {
        state: this.#state,
        schemaIntrospector: this.#config.schemaIntrospector,
      }),
    );
    this.#cachedSelectiveFieldsForExecute = selectiveFields;
    return selectiveFields;
  }

  #getSelectiveFieldsForPagination(): readonly SelectiveField[] | undefined {
    if (this.#cachedSelectiveFieldsForPagination === undefined) {
      return undefined;
    }

    if (this.#cachedSelectiveFieldsForPagination !== NOT_COMPUTED) {
      return this.#cachedSelectiveFieldsForPagination;
    }

    const tracker = new FieldAccessTracker();
    this.#trackSelectFunctionAccesses(tracker);
    if (!this.#recordOrderByFieldsForPagination(tracker)) {
      this.#cachedSelectiveFieldsForPagination = undefined;
      return undefined;
    }

    const selectiveFields = this.#ensureOptionalTraversalIdsSelected(
      buildSelectiveFields(tracker.getAccessedFields(), {
        state: this.#state,
        schemaIntrospector: this.#config.schemaIntrospector,
      }),
    );
    this.#cachedSelectiveFieldsForPagination = selectiveFields;
    return selectiveFields;
  }

  #ensureOptionalTraversalIdsSelected(
    selectiveFields: readonly SelectiveField[],
  ): readonly SelectiveField[] {
    const result = [...selectiveFields];
    const keys = new Set(
      result.map(
        (field) =>
          `${field.alias}\u0000${field.field}\u0000${String(field.isSystemField)}`,
      ),
    );

    function add(alias: string): void {
      const key = `${alias}\u0000id\u0000true`;
      if (keys.has(key)) return;
      keys.add(key);
      result.push({
        alias,
        field: "id",
        outputName: `${alias}_id`,
        isSystemField: true,
      });
    }

    for (const traversal of this.#state.traversals) {
      if (!traversal.optional) continue;
      add(traversal.nodeAlias);
      add(traversal.edgeAlias);
    }

    return result.toSorted((a, b) => {
      const aliasCompare = a.alias.localeCompare(b.alias);
      if (aliasCompare !== 0) return aliasCompare;
      return a.field.localeCompare(b.field);
    });
  }

  async #tryOptimizedPaginate(
    cursorData: CursorData | undefined,
    direction: "forward" | "backward",
    pageLimit: number,
    fetchLimit: number,
    cursor: string | undefined,
    isBackward: boolean,
  ): Promise<PaginatedResult<R> | undefined> {
    // Skip optimization for variable-length traversals (recursive compiler path)
    const hasVariableLength = this.#state.traversals.some(
      (t) => t.variableLength !== undefined,
    );
    if (hasVariableLength) return undefined;

    const selectiveFields = this.#getSelectiveFieldsForPagination();
    if (selectiveFields === undefined) {
      return undefined;
    }

    const rows = await this.#executeWithCursor(
      cursorData,
      direction,
      fetchLimit,
      {
        selectiveFields,
      },
    );

    const hasMore = rows.length > pageLimit;
    const resultRows = hasMore ? rows.slice(0, pageLimit) : rows;
    const orderedRows = isBackward ? resultRows.toReversed() : resultRows;

    let data: readonly R[];
    try {
      data = mapSelectiveResults<Aliases, EdgeAliases, R>(
        orderedRows,
        this.#state,
        selectiveFields,
        this.#config.schemaIntrospector,
        this.#selectFn,
      );
    } catch (error) {
      if (error instanceof MissingSelectiveFieldError) {
        this.#cachedSelectiveFieldsForPagination = undefined;
        return undefined;
      }
      throw error;
    }

    let nextCursor: string | undefined;
    let previousCursor: string | undefined;

    if (orderedRows.length > 0) {
      try {
        previousCursor = this.#buildCursorFromSelectiveRow(
          orderedRows[0]!,
          selectiveFields,
          "b",
        );
        nextCursor = this.#buildCursorFromSelectiveRow(
          orderedRows.at(-1)!,
          selectiveFields,
          "f",
        );
      } catch (error) {
        if (error instanceof MissingSelectiveFieldError) {
          this.#cachedSelectiveFieldsForPagination = undefined;
          return undefined;
        }
        throw error;
      }
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

  #recordOrderByFieldsForPagination(tracker: FieldAccessTracker): boolean {
    for (const spec of this.#state.orderBy) {
      const field = spec.field;
      if (field.path.length !== 1 || field.path[0] !== "props") {
        return false;
      }

      if (field.jsonPointer === undefined) {
        return false;
      }

      const segments = parseJsonPointer(field.jsonPointer);
      if (segments.length !== 1) {
        return false;
      }

      tracker.record(field.alias, segments[0]!, false);
    }

    return true;
  }

  #buildCursorFromSelectiveRow(
    row: Record<string, unknown>,
    selectiveFields: readonly SelectiveField[],
    direction: "f" | "b",
  ): string {
    const contextRow = this.#buildCursorContextFromSelectiveRow(
      row,
      selectiveFields,
    );
    return buildCursorFromRow(contextRow, this.#state.orderBy, direction);
  }

  #buildCursorContextFromSelectiveRow(
    row: Record<string, unknown>,
    selectiveFields: readonly SelectiveField[],
  ): Record<string, unknown> {
    const outputNameByAliasField = new Map<string, string>();
    for (const field of selectiveFields) {
      outputNameByAliasField.set(
        `${field.alias}\u0000${field.field}`,
        field.outputName,
      );
    }

    const optionalNodeAliases = new Set<string>();
    for (const traversal of this.#state.traversals) {
      if (traversal.optional) {
        optionalNodeAliases.add(traversal.nodeAlias);
      }
    }

    const cursorContext: Record<string, unknown> = {};

    for (const spec of this.#state.orderBy) {
      const alias = spec.field.alias;
      const jsonPointer = spec.field.jsonPointer;
      if (jsonPointer === undefined) {
        throw new MissingSelectiveFieldError(alias, "orderBy");
      }

      const segments = parseJsonPointer(jsonPointer);
      if (segments.length === 0) {
        throw new MissingSelectiveFieldError(alias, "orderBy");
      }

      const topField = segments[0]!;
      const outputName = outputNameByAliasField.get(
        `${alias}\u0000${topField}`,
      );
      if (outputName === undefined) {
        throw new MissingSelectiveFieldError(alias, topField);
      }

      if (optionalNodeAliases.has(alias)) {
        const idOutputName = outputNameByAliasField.get(`${alias}\u0000id`);
        if (idOutputName === undefined) {
          throw new MissingSelectiveFieldError(alias, "id");
        }
        const idValue = row[idOutputName];
        if (idValue === null || idValue === undefined) {
          continue;
        }
      }

      let aliasObject: Record<string, unknown>;
      const existing = cursorContext[alias];
      if (typeof existing === "object" && existing !== null) {
        aliasObject = existing as Record<string, unknown>;
      } else {
        aliasObject = {};
        cursorContext[alias] = aliasObject;
      }

      const kindNames = this.#getNodeKindNamesForAlias(alias);
      const typeInfo =
        kindNames ?
          this.#config.schemaIntrospector.getSharedFieldTypeInfo(
            kindNames,
            topField,
          )
        : undefined;

      const decoded = decodeSelectedValue(row[outputName], typeInfo);

      if (segments.length === 1) {
        aliasObject[topField] = decoded;
        continue;
      }

      let current = aliasObject;
      for (let index = 0; index < segments.length - 1; index++) {
        const segment = segments[index]!;
        const existing_ = current[segment];
        if (typeof existing_ === "object" && existing_ !== null) {
          current = existing_ as Record<string, unknown>;
        } else {
          const created: Record<string, unknown> = {};
          current[segment] = created;
          current = created;
        }
      }
      current[segments.at(-1)!] = decoded;
    }

    return cursorContext;
  }

  #getNodeKindNamesForAlias(alias: string): readonly string[] | undefined {
    if (alias === this.#state.startAlias) {
      return this.#state.startKinds;
    }
    return this.#state.traversals.find((t) => t.nodeAlias === alias)?.nodeKinds;
  }

  /**
   * Executes a paginated query using cursor-based keyset pagination.
   *
   * Cursor pagination is efficient for large datasets as it avoids OFFSET.
   * Requires ORDER BY to be specified for deterministic results.
   *
   * @param options - Pagination options (first/after for forward, last/before for backward)
   * @throws ValidationError if ORDER BY is not specified
   * @throws ValidationError if cursor columns don't match query ORDER BY columns
   */
  async paginate(options: PaginateOptions): Promise<PaginatedResult<R>> {
    if (!this.#config.backend) {
      throw new Error(
        "Cannot execute query: no backend configured. " +
          "Use store.query() or pass a backend to createQueryBuilder().",
      );
    }

    // Validate ORDER BY is present
    if (this.#state.orderBy.length === 0) {
      throw new ValidationError(
        "Cursor pagination requires ORDER BY. Add .orderBy() before .paginate()",
        {
          issues: [
            {
              path: "orderBy",
              message: "ORDER BY is required for cursor pagination",
            },
          ],
        },
        {
          suggestion: `Add .orderBy(alias, field) before .paginate() to specify sort order.`,
        },
      );
    }

    // Determine pagination direction and parameters
    const isBackward =
      options.last !== undefined || options.before !== undefined;
    const limit = options.first ?? options.last ?? 20;
    const cursor = options.after ?? options.before;

    // Decode and validate cursor if provided
    let cursorData: CursorData | undefined;
    if (cursor) {
      cursorData = decodeCursor(cursor);
      validateCursorColumns(cursorData, this.#state.orderBy);
    }

    // Fetch limit + 1 to detect if there are more pages
    const fetchLimit = limit + 1;

    const direction = isBackward ? "backward" : "forward";
    const optimized = await this.#tryOptimizedPaginate(
      cursorData,
      direction,
      limit,
      fetchLimit,
      cursor,
      isBackward,
    );
    if (optimized !== undefined) {
      return optimized;
    }

    // Build and execute query with cursor condition
    const rows = await this.#executeWithCursor(
      cursorData,
      direction,
      fetchLimit,
    );

    // Detect if there are more items
    const hasMore = rows.length > limit;
    const resultRows = hasMore ? rows.slice(0, limit) : rows;

    // For backward pagination, reverse the results to maintain natural order
    const orderedRows = isBackward ? resultRows.toReversed() : resultRows;

    // Map to typed results
    const data = mapResults(
      orderedRows,
      this.#state.startAlias,
      this.#state.traversals,
      this.#selectFn,
    );

    // Build paginated result with cursors
    return buildPaginatedResult(
      data,
      orderedRows,
      this.#state.orderBy,
      limit,
      hasMore,
      isBackward,
      cursor,
      (row) =>
        buildSelectContext<Aliases, EdgeAliases>(
          row,
          this.#state.startAlias,
          this.#state.traversals,
        ),
    );
  }

  /**
   * Returns an async iterator that streams results in batches.
   *
   * Uses cursor pagination internally for efficient memory usage.
   * Requires ORDER BY to be specified for deterministic results.
   *
   * @param options - Stream options (batchSize defaults to 1000)
   * @throws ValidationError if ORDER BY is not specified
   */
  stream(options?: StreamOptions): AsyncIterable<R> {
    // Validate ORDER BY is present
    if (this.#state.orderBy.length === 0) {
      throw new ValidationError(
        "Streaming requires ORDER BY. Add .orderBy() before .stream()",
        {
          issues: [
            { path: "orderBy", message: "ORDER BY is required for streaming" },
          ],
        },
        {
          suggestion: `Add .orderBy(alias, field) before .stream() to specify sort order.`,
        },
      );
    }

    const batchSize = getStreamBatchSize(options);
    return createStreamIterable(batchSize, (paginateOptions) =>
      this.paginate(paginateOptions),
    );
  }

  /**
   * Executes a query with cursor conditions applied.
   */
  async #executeWithCursor(
    cursorData: CursorData | undefined,
    direction: "forward" | "backward",
    limit: number,
    options?: Readonly<{ selectiveFields?: readonly SelectiveField[] }>,
  ): Promise<readonly Record<string, unknown>[]> {
    const ast = this.toAst();

    // Adjust ORDER BY for backward pagination (reverse all directions)
    let orderBy = this.#state.orderBy;
    if (direction === "backward") {
      orderBy = orderBy.map((spec) => ({
        ...spec,
        direction:
          spec.direction === "asc" ? ("desc" as const) : ("asc" as const),
      }));
    }

    // Build cursor predicates if we have cursor data
    let predicates = [...this.#state.predicates];
    if (cursorData) {
      const cursorPredicate = buildCursorPredicate(
        cursorData,
        this.#state.orderBy,
        direction,
        this.#state.startAlias,
      );
      predicates = [...predicates, cursorPredicate];
    }

    // Apply modified ORDER BY, predicates, and limit to AST (discard offset)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { offset: _discarded, ...astWithoutOffset } = ast;
    const modifiedAst = {
      ...astWithoutOffset,
      predicates,
      orderBy,
      limit,
      ...(options?.selectiveFields !== undefined && {
        selectiveFields: options.selectiveFields,
      }),
    };

    // Compile and execute
    const compiled = compileQuery(
      modifiedAst,
      this.#config.graphId,
      this.#compileOptions(),
    );
    const rawRows =
      await this.#config.backend!.execute<Record<string, unknown>>(compiled);
    const dialect = this.#config.dialect ?? "sqlite";
    return transformPathColumns(rawRows, this.#state, dialect);
  }
}
