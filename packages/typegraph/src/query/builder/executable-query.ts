/**
 * ExecutableQuery - A query that can be executed, paginated, or streamed.
 */
import { backendDerivationRoot } from "../../backend/derive-backend";
import {
  type GraphBackend,
  type TransactionBackend,
} from "../../backend/types";
import { DEFAULT_PAGINATION_LIMIT } from "../../constants";
import { type GraphDef } from "../../core/define-graph";
import {
  ConfigurationError,
  UnsupportedPredicateError,
  ValidationError,
} from "../../errors";
import { compareStrings } from "../../utils/compare";
import { requireDefined } from "../../utils/presence";
import { withRecordedRelationsPrecondition } from "../../utils/sql-errors";
import {
  type FieldRef,
  mergeEdgeKinds,
  type OrderSpec,
  type QueryAst,
  type SelectiveField,
  type SortDirection,
} from "../ast";
import { compileQuery, type CompileQueryOptions } from "../compiler/index";
import {
  buildCursorFromRow,
  buildCursorFromValues,
  type CursorData,
  decodeCursor,
  requireCursorField,
  validateCursorColumns,
} from "../cursor";
import { type SqlDialect } from "../dialect/types";
import {
  adjustOrderByForDirection,
  buildCursorPredicate,
  buildPaginatedResult,
  buildPaginatedResultFromRows,
  buildSelectContext,
  buildSelectiveFields,
  containsSelectableAliasObject,
  createStreamIterable,
  createTrackingContext,
  decodeSelectedValue,
  executeSchemaCheckedRead,
  FieldAccessTracker,
  getStreamBatchSize,
  mapResults,
  mapSelectiveResults,
  MissingSelectiveFieldError,
  nullToUndefined,
  transformPathColumns,
} from "../execution";
import { parseJsonPointer } from "../json-pointer";
import { resolveNullOrdering } from "../order";
import { type FieldTypeInfo } from "../schema-introspector";
import { type CompiledSelectSql } from "../sql-intent";
import { buildQueryAst } from "./ast-builder";
import { buildCompileOptions } from "./compile-options";
import { getQueryBuilderInternalContext } from "./internal-context";
import { oneStatementBatchOrderColumn } from "./one-statement-batch";
import {
  assertCompatibleSetOperationProvenance,
  type OneStatementReadProvenance,
} from "./one-statement-provenance";
import {
  assertSharedNodeField,
  buildOrderSpec,
  resolveSystemOrderField,
} from "./order-by-field";
import { hasParameterReferences, PreparedQuery } from "./prepared-query";
import {
  buildQueryTemplate,
  type CompiledTemplate,
  fillTemplateParams,
} from "./read-instant-template";
import { executeQueryTerminal } from "./terminal-query";
import {
  type AliasMap,
  type CompiledOneStatementRead,
  type EdgeAliasMap,
  type NodeCandidateSelection,
  type OneStatementBatchableQuery,
  type PaginatedResult,
  type PaginateOptions,
  type QueryBuilderConfig,
  type QueryBuilderState,
  type RecursiveAliasMap,
  type SelectContext,
  type StreamOptions,
} from "./types";
import { type UnionableQuery } from "./unionable-query";
import { validatePaginationOptions, validateQueryRange } from "./validation";

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
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Empty when no recursive aliases
  RecursiveAliases extends RecursiveAliasMap = {},
  R = unknown,
> {
  readonly #config: QueryBuilderConfig;
  readonly #state: QueryBuilderState;
  readonly #selectFn: (
    context: SelectContext<Aliases, EdgeAliases, RecursiveAliases>,
  ) => R;
  #cachedSelectiveFieldsForExecute:
    readonly SelectiveField[] | typeof NOT_COMPUTED | undefined = NOT_COMPUTED;
  #cachedSelectiveFieldsForPagination:
    readonly SelectiveField[] | typeof NOT_COMPUTED | undefined = NOT_COMPUTED;
  // The instance is immutable (every builder method returns a new instance),
  // so the AST and its param-ref check are invariant — compute each once and
  // reuse across execute()/paginate()/stream() instead of rebuilding per call.
  #cachedAst: QueryAst | undefined;
  #cachedHasParameterReferences: boolean | undefined;
  // Per-instance compiled placeholder templates for the full and
  // selective-field ASTs (NOT_COMPUTED = not yet built; undefined = no fast
  // path). Reused across execute()/executeOn() calls so a repeated query
  // compiles once; the read instant is filled fresh per call, never cached.
  #fullTemplate: CompiledTemplate | typeof NOT_COMPUTED | undefined =
    NOT_COMPUTED;
  #selectiveTemplate: CompiledTemplate | typeof NOT_COMPUTED | undefined =
    NOT_COMPUTED;

  constructor(
    config: QueryBuilderConfig,
    state: QueryBuilderState,
    selectFunction: (
      context: SelectContext<Aliases, EdgeAliases, RecursiveAliases>,
    ) => R,
  ) {
    this.#config = config;
    this.#state = state;
    this.#selectFn = selectFunction;
  }

  /**
   * Builds the query AST (memoized — the instance is immutable).
   */
  toAst(): QueryAst {
    return (this.#cachedAst ??= buildQueryAst(this.#config, this.#state));
  }

  /** Whether this query uses `param()` refs (memoized). */
  #hasParameterReferences(): boolean {
    return (this.#cachedHasParameterReferences ??= hasParameterReferences(
      this.toAst(),
    ));
  }

  /**
   * Orders results.
   */
  orderBy<A extends (keyof Aliases | keyof EdgeAliases) & string>(
    alias: A,
    field: string,
    direction: SortDirection = "asc",
  ): ExecutableQuery<G, Aliases, EdgeAliases, RecursiveAliases, R> {
    const edgeTraversal = this.#state.traversals.find(
      (traversal) => traversal.edgeAlias === alias,
    );
    const isEdge = edgeTraversal !== undefined;
    const edgeKindNames =
      edgeTraversal === undefined ? undefined : mergeEdgeKinds(edgeTraversal);
    const nodeKindNames =
      isEdge ? undefined
      : alias === this.#state.startAlias ? this.#state.startKinds
      : this.#state.traversals.find(
          (traversal) => traversal.nodeAlias === alias,
        )?.nodeKinds;
    const hasDeclaredProperty =
      edgeKindNames ?
        this.#config.schemaIntrospector.hasDeclaredEdgeField(
          edgeKindNames,
          field,
        )
      : nodeKindNames !== undefined &&
        this.#config.schemaIntrospector.hasDeclaredField(nodeKindNames, field);
    const systemField = resolveSystemOrderField(
      alias,
      field,
      isEdge,
      hasDeclaredProperty,
    );

    let typeInfo: FieldTypeInfo | undefined;
    if (systemField === undefined) {
      if (edgeKindNames) {
        typeInfo = this.#config.schemaIntrospector.getSharedEdgeFieldTypeInfo(
          edgeKindNames,
          field,
        );
      } else {
        typeInfo =
          nodeKindNames ?
            this.#config.schemaIntrospector.getSharedFieldTypeInfo(
              nodeKindNames,
              field,
            )
          : undefined;
        assertSharedNodeField(nodeKindNames, field, typeInfo);
      }
    }

    const orderSpec = buildOrderSpec(
      alias,
      field,
      direction,
      systemField,
      typeInfo,
    );

    const newState: QueryBuilderState = {
      ...this.#state,
      orderBy: [...this.#state.orderBy, orderSpec],
    };

    return new ExecutableQuery(this.#config, newState, this.#selectFn);
  }

  /**
   * Limits the number of results.
   */
  limit(
    n: number,
  ): ExecutableQuery<G, Aliases, EdgeAliases, RecursiveAliases, R> {
    validateQueryRange(n, "limit");
    return new ExecutableQuery(
      this.#config,
      { ...this.#state, limit: n },
      this.#selectFn,
    );
  }

  /**
   * Offsets the results.
   */
  offset(
    n: number,
  ): ExecutableQuery<G, Aliases, EdgeAliases, RecursiveAliases, R> {
    validateQueryRange(n, "offset");
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
      query: ExecutableQuery<G, Aliases, EdgeAliases, RecursiveAliases, R>,
    ) => ExecutableQuery<G, Aliases, EdgeAliases, RecursiveAliases, NewR>,
  ): ExecutableQuery<G, Aliases, EdgeAliases, RecursiveAliases, NewR> {
    return fragment(this);
  }

  /**
   * Combines this query with another using UNION (removes duplicates).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Allow any alias map for set operations
  union(other: ExecutableQuery<G, any, any, any, R>): UnionableQuery<G, R> {
    this.#assertCompatibleSetOperand(other);
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
  unionAll(other: ExecutableQuery<G, any, any, any, R>): UnionableQuery<G, R> {
    this.#assertCompatibleSetOperand(other);
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
  intersect(other: ExecutableQuery<G, any, any, any, R>): UnionableQuery<G, R> {
    this.#assertCompatibleSetOperand(other);
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
  except(other: ExecutableQuery<G, any, any, any, R>): UnionableQuery<G, R> {
    this.#assertCompatibleSetOperand(other);
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
   * Compiles the query and returns the SQL text and parameters.
   *
   * Requires a backend to be configured (the backend determines the SQL dialect).
   * Use this for debugging, logging, or running the query with a custom executor.
   */
  toSQL(): Readonly<{ sql: string; params: readonly unknown[] }> {
    if (!this.#config.backend?.compileSql) {
      throw new Error(
        "Cannot convert to SQL: no backend configured or backend does not support compileSql. " +
          "Use store.query() to get a backend-aware query builder.",
      );
    }
    return this.#config.backend.compileSql(this.compile());
  }

  /**
   * Compiles the query to TypeGraph's database-independent SQL fragment.
   *
   * Pass the result to a GraphBackend, or use toSQL() to render SQL text and
   * parameters for the configured dialect.
   */
  compile(): CompiledSelectSql {
    // Emits a directly-runnable statement with the read instant as a literal
    // (a backend may execute the result directly), so this is not the
    // reusable placeholder template execute() caches — see #templateFor.
    const ast = this.toAst();
    return compileQuery(ast, this.#config.graphId, this.#compileOptions());
  }

  /**
   * Compiles only the root node identity for use by a set-based mutation.
   * This deliberately ignores the JavaScript selector supplied to
   * `.select(...)`: candidate identity is always the root id, so changing a
   * result projection cannot make the mutation reference a missing column.
   */
  compileNodeCandidateIds(readInstant?: string): CompiledSelectSql {
    const ast = this.toAst();
    const idColumn = `${ast.start.alias}_id`;
    return compileQuery(
      {
        ...ast,
        ...(readInstant === undefined ?
          {}
        : {
            temporalMode: {
              mode: "asOf",
              asOf: readInstant,
            },
          }),
        projection: {
          fields: [
            {
              outputName: idColumn,
              source: {
                __type: "field_ref",
                alias: ast.start.alias,
                path: ["id"],
                valueType: "string",
              },
            },
          ],
        },
      },
      this.#config.graphId,
      this.#compileOptions(),
    );
  }

  /**
   * Creates a prepared (pre-validated) query that can be executed multiple
   * times with different parameter bindings. Builds and structurally
   * validates the AST once (a malformed query fails fast, here, instead of on
   * first use); the prepared query then compiles once into a reusable template
   * and fills a fresh read instant per execute() — see PreparedQuery's class
   * doc comment, which also covers the two cases that recompile per call
   * instead (no `executeRaw`, or a statement whose semantics ride on the SQL
   * object rather than its text).
   *
   * Use `param("name")` in predicates to create parameterized slots,
   * then pass values via `prepared.execute({ name: "value" })`.
   *
   * @example
   * ```typescript
   * import { param } from "@nicia-ai/typegraph";
   *
   * const prepared = store.query()
   *   .from("Person", "p")
   *   .whereNode("p", (p) => p.name.eq(param("name")))
   *   .select((ctx) => ctx.p)
   *   .prepare();
   *
   * const alice = await prepared.execute({ name: "Alice" });
   * const bob = await prepared.execute({ name: "Bob" });
   * ```
   *
   * @throws Error if no backend is configured
   */
  prepare(): PreparedQuery<R> {
    if (
      getQueryBuilderInternalContext(this.#config).expectedSchemaVersion !==
      undefined
    ) {
      throw new ConfigurationError(
        "Prepared queries are unavailable inside withCheckedReads().",
        { operation: "withCheckedReads.prepare" },
      );
    }
    if (!this.#config.backend) {
      throw new Error(
        "Cannot prepare query: no backend configured. " +
          "Use store.query() or pass a backend to createQueryBuilder().",
      );
    }

    // Build AST once
    const baseAst = this.toAst();

    // Attempt selective field optimization
    const selectiveFields = this.#getSelectiveFieldsForExecute();
    const ast =
      selectiveFields === undefined ? baseAst : { ...baseAst, selectiveFields };
    const unoptimizedAst = baseAst;

    // Compile once here purely to fail fast on a malformed query. PreparedQuery
    // caches its own reusable placeholder template (built lazily on first
    // execute), so this validation compile is safe to discard — it only exists
    // to surface a structural error at prepare() time rather than first use.
    const compileOptions = this.#compileOptions();
    compileQuery(ast, this.#config.graphId, compileOptions);
    compileQuery(unoptimizedAst, this.#config.graphId, compileOptions);

    return new PreparedQuery({
      ast,
      unoptimizedAst,
      backend: this.#config.backend,
      dialect: this.#config.dialect ?? "sqlite",
      graphId: this.#config.graphId,
      compileOptions: compileOptions,
      state: this.#state,
      selectiveFields,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Type erasure needed for PreparedQuery which uses AliasMap
      selectFn: this.#selectFn as (context: SelectContext<any, any>) => R,
      schemaIntrospector: this.#config.schemaIntrospector,
    });
  }

  /**
   * Builds compile options from the config.
   */
  #compileOptions(): CompileQueryOptions {
    return buildCompileOptions(this.#config);
  }

  #requireBackend(): GraphBackend {
    const { backend } = this.#config;
    if (backend === undefined) {
      throw new Error(
        "Cannot execute query: no backend configured. " +
          "Provide a backend when creating the QueryBuilder.",
      );
    }
    return backend;
  }

  #executeOnBackend<T>(
    backend: GraphBackend | TransactionBackend,
    promise: Promise<T>,
    surface: string,
  ): Promise<T> {
    if (this.#state.recordedAsOf === undefined) return promise;
    return withRecordedRelationsPrecondition(promise, {
      dialect: backend.dialect,
      surface,
    });
  }

  #dialect(): SqlDialect {
    return this.#config.dialect ?? "sqlite";
  }

  /**
   * The cached placeholder template for one AST variant (`"full"` or
   * `"selective"`), or `undefined` when no fast path applies. Built once per
   * instance from the store backend's compiler; reusable across executions and
   * across store/transaction backends of the same dialect, since SQL text and
   * parameters depend only on the AST and dialect. The read instant is filled
   * fresh per call by {@link fillTemplateParams}, never frozen into the cache.
   */
  #templateFor(
    ast: QueryAst,
    slot: "full" | "selective",
  ): CompiledTemplate | undefined {
    const cached =
      slot === "full" ? this.#fullTemplate : this.#selectiveTemplate;
    if (cached !== NOT_COMPUTED) return cached;
    const built = this.#buildTemplate(ast);
    if (slot === "full") this.#fullTemplate = built;
    else this.#selectiveTemplate = built;
    return built;
  }

  #buildTemplate(ast: QueryAst): CompiledTemplate | undefined {
    return buildQueryTemplate(
      ast,
      this.#config.graphId,
      this.#compileOptions(),
      this.#config.backend,
    );
  }

  /**
   * Fetches raw rows for one AST variant, path-column-normalized. Prefers the
   * cached template + `executeRaw` fast path; falls back to a fresh literal
   * compile via `backend.execute` when the backend cannot run raw SQL text (in
   * which case no template is built). Callers map the returned rows to typed
   * results.
   */
  async #fetchRows(
    backend: GraphBackend | TransactionBackend,
    ast: QueryAst,
    slot: "full" | "selective",
    surface: string,
  ): Promise<readonly Record<string, unknown>[]> {
    const executeRaw = backend.executeRaw;
    const template =
      executeRaw === undefined ? undefined : this.#templateFor(ast, slot);
    const rawRows = await this.#executeOnBackend(
      backend,
      template !== undefined && executeRaw !== undefined ?
        executeRaw<Record<string, unknown>>(
          template.sql,
          fillTemplateParams(template.params, {}, this.#dialect()),
        )
      : backend.execute<Record<string, unknown>>(
          compileQuery(ast, this.#config.graphId, this.#compileOptions()),
        ),
      surface,
    );
    return transformPathColumns(rawRows, this.#state, this.#dialect());
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
    const backend = this.#config.backend;

    // Guard: reject queries with param() refs — must use .prepare().execute({...})
    const ast = this.toAst();
    if (this.#hasParameterReferences()) {
      throw new Error(
        "Query contains param() references. Use .prepare().execute({...}) instead of .execute().",
      );
    }

    const checked = getQueryBuilderInternalContext(
      this.#config,
    ).expectedSchemaVersion;
    if (checked !== undefined) return this.executeChecked(checked.value);

    // Phase 1: Try optimized execution
    const optimizedResult = await this.#tryOptimizedExecution();
    if (optimizedResult !== undefined) {
      return optimizedResult;
    }

    // Phase 2: Fall back to full fetch (cached template + executeRaw, or a
    // fresh literal compile on backends without raw execution).
    const rows = await this.#fetchRows(backend, ast, "full", "recorded-query");

    // Cast: runtime context includes recursive aliases; type erasure in mapResults is safe
    return mapResults<Aliases, EdgeAliases, R, RecursiveAliases>(
      rows,
      this.#state.startAlias,
      this.#state.traversals,
      this.#selectFn,
    );
  }

  /** Returns the first mapped row, preserving an existing zero limit. */
  async first(): Promise<R | undefined> {
    const query = this.limit(Math.min(this.#state.limit ?? 1, 1));
    if (query.#hasParameterReferences())
      throw new ConfigurationError(
        "first() requires bound values, not param() references.",
        { operation: "first" },
      );
    const checked = getQueryBuilderInternalContext(
      this.#config,
    ).expectedSchemaVersion;
    if (checked !== undefined) {
      const rows = await query.executeChecked(checked.value);
      return rows[0];
    }
    const rows = await query.#fetchRows(
      query.#requireBackend(),
      query.toAst(),
      "full",
      "recorded-query-first",
    );
    return mapResults<Aliases, EdgeAliases, R, RecursiveAliases>(
      rows,
      this.#state.startAlias,
      this.#state.traversals,
      this.#selectFn,
    )[0];
  }

  /** Counts SQL match rows after grouping, offset, and limit, without running the selector. */
  count(): Promise<number> {
    return executeQueryTerminal(this.#config, this.#state, "count");
  }

  /** Tests whether the bounded SQL relation has a row, without running the selector. */
  async exists(): Promise<boolean> {
    return (
      (await executeQueryTerminal(this.#config, this.#state, "exists")) > 0
    );
  }

  /**
   * Reads rows and the active schema version in one statement snapshot.
   * Throws SchemaChangedError before invoking the selector on stale rows,
   * including when the query has no matches. Reload the schema and rebuild
   * the query before retrying. This does not pin subsequent request reads.
   * Uses a full projection; relevance and recursive queries are refused.
   */
  async executeChecked(
    expectedSchemaVersion: number | undefined,
  ): Promise<readonly R[]> {
    if (this.#hasParameterReferences()) {
      throw new Error(
        "Checked reads require bound values, not param() references.",
      );
    }
    const ast = this.toAst();
    const backend = this.#requireBackend();
    const rows = await this.#executeOnBackend(
      backend,
      executeSchemaCheckedRead({
        backend,
        ast,
        graphId: this.#config.graphId,
        expectedVersion: expectedSchemaVersion,
        compile: () =>
          compileQuery(ast, this.#config.graphId, this.#compileOptions()),
      }),
      "recorded-checked-query",
    );
    return mapResults<Aliases, EdgeAliases, R, RecursiveAliases>(
      rows,
      this.#state.startAlias,
      this.#state.traversals,
      this.#selectFn,
    );
  }

  /**
   * Executes the query against a provided backend.
   *
   * Used by `store.batch()` to run several queries in sequence against one
   * target — a transaction on backends that have them, the backend itself
   * otherwise. The full compile → execute → transform pipeline runs
   * identically to `execute()`, but against the given backend.
   *
   * Costs one statement, or two when the selective-field path runs and its
   * mapping then falls back: `#tryOptimizedExecutionOn` detects that only
   * after its statement has executed, and the caller re-runs the full fetch.
   * The fallback clears the fast path for this instance.
   */
  async executeOn(
    backend: GraphBackend | TransactionBackend,
  ): Promise<readonly R[]> {
    const ast = this.toAst();
    // Guard: reject queries with param() refs — must use .prepare().execute({...})
    if (this.#hasParameterReferences()) {
      throw new Error(
        "Query contains param() references. Use .prepare().execute({...}) instead of .execute().",
      );
    }

    const checked = getQueryBuilderInternalContext(
      this.#config,
    ).expectedSchemaVersion;
    if (checked !== undefined) {
      const rows = await executeSchemaCheckedRead({
        backend,
        ast,
        graphId: this.#config.graphId,
        expectedVersion: checked.value,
        compile: () =>
          compileQuery(ast, this.#config.graphId, this.#compileOptions()),
      });
      return mapResults<Aliases, EdgeAliases, R, RecursiveAliases>(
        rows,
        this.#state.startAlias,
        this.#state.traversals,
        this.#selectFn,
      );
    }

    // Try optimized execution with the provided backend
    const optimizedResult = await this.#tryOptimizedExecutionOn(backend);
    if (optimizedResult !== undefined) {
      return optimizedResult;
    }

    // Fall back to full fetch (cached template + executeRaw on the provided
    // backend, or a fresh literal compile when it can't run raw SQL).
    const rows = await this.#fetchRows(
      backend,
      ast,
      "full",
      "recorded-batch-query",
    );

    return mapResults<Aliases, EdgeAliases, R, RecursiveAliases>(
      rows,
      this.#state.startAlias,
      this.#state.traversals,
      this.#selectFn,
    );
  }

  /** @internal Set-operation and batch provenance validation. */
  oneStatementBatchProvenance(): Readonly<{
    graphId: string;
    executionTarget: object | undefined;
  }> {
    return {
      graphId: this.#config.graphId,
      executionTarget:
        this.#config.backend === undefined ?
          undefined
        : backendDerivationRoot(this.#config.backend),
    };
  }

  /**
   * Describes this query as a candidate source for a set-based node update.
   * Candidate updates use the root node identity, so one concrete root kind is
   * required even when the query traverses other kinds.
   */
  toNodeCandidateSelection(): NodeCandidateSelection {
    if (
      getQueryBuilderInternalContext(this.#config).expectedSchemaVersion !==
      undefined
    ) {
      throw new ConfigurationError(
        "Queries from withCheckedReads() cannot be used as updateWhere() candidates.",
        {
          code: "SET_UPDATE_CANDIDATE_CHECKED_READS_UNSUPPORTED",
          operation: "updateWhere",
        },
      );
    }
    const ast = this.toAst();
    if (hasParameterReferences(ast)) {
      throw new ConfigurationError(
        "Set-update candidate queries cannot contain param() references; use concrete predicate values.",
        {
          code: "SET_UPDATE_CANDIDATE_PARAMETERS_UNSUPPORTED",
          operation: "updateWhere",
        },
      );
    }
    if (ast.groupBy !== undefined || ast.having !== undefined) {
      throw new ConfigurationError(
        "Set-update candidate queries cannot use groupBy() or having(); select node rows directly.",
        {
          code: "SET_UPDATE_CANDIDATE_GROUPING_UNSUPPORTED",
          operation: "updateWhere",
        },
      );
    }
    if (ast.start.kinds.length !== 1 || ast.start.expansion !== "exact") {
      throw new ConfigurationError(
        "A set-update candidate query must select one concrete node kind.",
        {
          operation: "updateWhere",
          candidateKinds: ast.start.kinds,
          expansion: ast.start.expansion,
        },
      );
    }
    const kind = ast.start.kinds[0];
    if (kind === undefined) {
      throw new ConfigurationError(
        "A set-update candidate query must have a node source.",
        { operation: "updateWhere" },
      );
    }
    return {
      graphId: this.#config.graphId,
      executionTarget:
        this.#config.backend === undefined ?
          undefined
        : backendDerivationRoot(this.#config.backend),
      kind,
      idColumn: `${ast.start.alias}_id`,
      temporalMode: ast.temporalMode.mode,
      recordedAsOf: ast.recordedAsOf,
    };
  }

  #assertCompatibleSetOperand(
    other: Readonly<{
      oneStatementBatchProvenance: () => OneStatementReadProvenance;
    }>,
  ): void {
    const own = this.oneStatementBatchProvenance();
    const candidate = other.oneStatementBatchProvenance();
    assertCompatibleSetOperationProvenance(own, candidate);
  }

  /** @internal Embedding contract consumed by `store.batchOnce()`. */
  compileOneStatementBatchItem?(): Readonly<{
    query: CompiledSelectSql;
    provenance: Readonly<{ graphId: string; executionTarget: object }>;
    outputNames: readonly string[];
    orderBy: readonly Readonly<{
      column: string;
      direction: "asc" | "desc";
      nulls: "first" | "last";
    }>[];
    mapRows: (rows: readonly Record<string, unknown>[]) => readonly R[];
  }> {
    if (
      getQueryBuilderInternalContext(this.#config).expectedSchemaVersion !==
      undefined
    ) {
      throw new ConfigurationError(
        "Queries from withCheckedReads() cannot be embedded in batchOnce().",
        { operation: "withCheckedReads.batchOnce" },
      );
    }
    if (this.#hasParameterReferences()) {
      throw new Error(
        "Query contains param() references. Bind prepared queries before batching.",
      );
    }
    const ast = this.toAst();
    const batchOrderBy = (ast.orderBy ?? []).map((order, index) => ({
      column: oneStatementBatchOrderColumn(index),
      direction: order.direction,
      nulls: resolveNullOrdering(order),
    }));
    const batchAst: QueryAst =
      batchOrderBy.length === 0 ?
        ast
      : {
          ...ast,
          projection: {
            fields: [
              ...ast.projection.fields,
              ...(ast.orderBy ?? []).map((order, index) => ({
                outputName: oneStatementBatchOrderColumn(index),
                source: order.field,
              })),
            ],
          },
        };
    const recursiveOutputNames = batchAst.traversals.flatMap((traversal) => {
      const variableLength = traversal.variableLength;
      return variableLength === undefined ?
          []
        : [variableLength.depthAlias, variableLength.pathAlias].filter(
            (name): name is string => name !== undefined,
          );
    });
    return {
      query: compileQuery(
        batchAst,
        this.#config.graphId,
        this.#compileOptions(),
      ),
      provenance: {
        graphId: this.#config.graphId,
        executionTarget: backendDerivationRoot(
          requireDefined(this.#config.backend),
        ),
      },
      outputNames: [
        ...ast.projection.fields.map((field) => field.outputName),
        ...recursiveOutputNames.filter(
          (name) =>
            !ast.projection.fields.some((field) => field.outputName === name),
        ),
      ],
      orderBy: batchOrderBy,
      mapRows: (rows) =>
        mapResults<Aliases, EdgeAliases, R, RecursiveAliases>(
          transformPathColumns(rows, this.#state, this.#dialect()),
          this.#state.startAlias,
          this.#state.traversals,
          this.#selectFn,
        ),
    };
  }

  /**
   * Attempts optimized execution by tracking which fields the select callback accesses.
   *
   * Returns undefined if optimization is not possible (callback uses method calls,
   * computations, or returns whole nodes).
   */
  async #tryOptimizedExecution(): Promise<readonly R[] | undefined> {
    const selectiveFields = this.#getSelectiveFieldsForExecute();
    if (selectiveFields === undefined) {
      return undefined;
    }

    // Cached template + executeRaw when available; the read instant is filled
    // fresh per call, so a reused query never freezes "now" (the #246
    // regression) yet compiles only once.
    const baseAst = this.toAst();
    const selectiveAst = { ...baseAst, selectiveFields };

    const backend = this.#requireBackend();
    const rows = await this.#fetchRows(
      backend,
      selectiveAst,
      "selective",
      "recorded-query",
    );

    try {
      // RecursiveAliases are populated at runtime but erased in mapSelectiveResults' signature
      return mapSelectiveResults<Aliases, EdgeAliases, R>(
        rows,
        this.#state,
        selectiveFields,
        this.#config.schemaIntrospector,
        this.#selectFn as (context: SelectContext<Aliases, EdgeAliases>) => R,
      );
    } catch (error) {
      if (error instanceof MissingSelectiveFieldError) {
        this.#cachedSelectiveFieldsForExecute = undefined;
        return undefined;
      }
      if (error instanceof UnsupportedPredicateError) {
        this.#cachedSelectiveFieldsForExecute = undefined;
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Attempts optimized execution against a provided backend.
   * Mirror of #tryOptimizedExecution but delegates to the given backend.
   */
  async #tryOptimizedExecutionOn(
    backend: GraphBackend | TransactionBackend,
  ): Promise<readonly R[] | undefined> {
    const selectiveFields = this.#getSelectiveFieldsForExecute();
    if (selectiveFields === undefined) {
      return undefined;
    }

    // Cached template + executeRaw on the provided backend; see
    // #tryOptimizedExecution.
    const baseAst = this.toAst();
    const selectiveAst = { ...baseAst, selectiveFields };

    const rows = await this.#fetchRows(
      backend,
      selectiveAst,
      "selective",
      "recorded-batch-query",
    );

    try {
      return mapSelectiveResults<Aliases, EdgeAliases, R>(
        rows,
        this.#state,
        selectiveFields,
        this.#config.schemaIntrospector,
        this.#selectFn as (context: SelectContext<Aliases, EdgeAliases>) => R,
      );
    } catch (error) {
      if (error instanceof MissingSelectiveFieldError) {
        this.#cachedSelectiveFieldsForExecute = undefined;
        return undefined;
      }
      if (error instanceof UnsupportedPredicateError) {
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

    const presentTrackingRuns = [
      { mode: "truthy", optionalTraversalAliases: "present" },
      { mode: "max", optionalTraversalAliases: "present" },
      { mode: "falsy", optionalTraversalAliases: "present" },
    ] as const;
    const trackingRuns =
      hasOptionalTraversal ?
        [
          ...presentTrackingRuns,
          { mode: "falsy", optionalTraversalAliases: "absent" } as const,
        ]
      : presentTrackingRuns;

    for (const run of trackingRuns) {
      const trackingContext = createTrackingContext(this.#state, tracker, {
        schemaIntrospector: this.#config.schemaIntrospector,
        mode: run.mode,
        optionalTraversalAliases: run.optionalTraversalAliases,
      });

      try {
        // Execute the select callback against a lightweight tracking context.
        const selected = this.#selectFn(
          trackingContext as SelectContext<
            Aliases,
            EdgeAliases,
            RecursiveAliases
          >,
        );
        if (containsSelectableAliasObject(selected))
          tracker.requiresFullRow = true;
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
    if (tracker.requiresFullRow || accessed.length === 0) {
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
    if (
      tracker.requiresFullRow ||
      !this.#recordOrderByFieldsForPagination(tracker)
    ) {
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
      if (traversal.variableLength === undefined) add(traversal.edgeAlias);
    }

    return result.toSorted((a, b) => {
      const aliasCompare = compareStrings(a.alias, b.alias);
      if (aliasCompare !== 0) return aliasCompare;
      return compareStrings(a.field, b.field);
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
    const selectiveFields = this.#getSelectiveFieldsForPagination();
    if (selectiveFields === undefined) {
      return undefined;
    }

    let rows: readonly Record<string, unknown>[];
    try {
      rows = await this.#executeWithCursor(cursorData, direction, fetchLimit, {
        selectiveFields,
      });
    } catch (error) {
      if (error instanceof UnsupportedPredicateError) {
        this.#cachedSelectiveFieldsForPagination = undefined;
        return undefined;
      }
      throw error;
    }

    const hasMore = rows.length > pageLimit;
    const resultRows = hasMore ? rows.slice(0, pageLimit) : rows;
    const paginationDialect = this.#config.dialect ?? "sqlite";
    const orderedRows = transformPathColumns(
      isBackward ? resultRows.toReversed() : resultRows,
      this.#state,
      paginationDialect,
    );

    let data: readonly R[];
    try {
      // RecursiveAliases are populated at runtime but erased in mapSelectiveResults' signature
      data = mapSelectiveResults<Aliases, EdgeAliases, R>(
        orderedRows,
        this.#state,
        selectiveFields,
        this.#config.schemaIntrospector,
        this.#selectFn as (context: SelectContext<Aliases, EdgeAliases>) => R,
      );
    } catch (error) {
      if (error instanceof MissingSelectiveFieldError) {
        this.#cachedSelectiveFieldsForPagination = undefined;
        return undefined;
      }
      if (error instanceof UnsupportedPredicateError) {
        this.#cachedSelectiveFieldsForPagination = undefined;
        return undefined;
      }
      throw error;
    }

    try {
      return buildPaginatedResultFromRows(
        data,
        orderedRows,
        hasMore,
        isBackward,
        cursor,
        (row, cursorDirection) =>
          this.#buildCursorFromSelectiveRow(
            row,
            selectiveFields,
            cursorDirection,
          ),
      );
    } catch (error) {
      if (error instanceof MissingSelectiveFieldError) {
        this.#cachedSelectiveFieldsForPagination = undefined;
        return undefined;
      }
      if (error instanceof UnsupportedPredicateError) {
        this.#cachedSelectiveFieldsForPagination = undefined;
        return undefined;
      }
      throw error;
    }
  }

  #recordOrderByFieldsForPagination(tracker: FieldAccessTracker): boolean {
    for (const spec of this.#paginationOrderBy()) {
      const field = spec.field;

      // System field (e.g., id, kind) — path is ["id"] or ["kind"]
      if (
        field.path.length === 1 &&
        field.path[0] !== "props" &&
        field.jsonPointer === undefined
      ) {
        tracker.record(field.alias, requireDefined(field.path[0]), true);
        continue;
      }

      // Props field — path is ["props"] with a JSON pointer
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

      tracker.record(field.alias, requireDefined(segments[0]), false);
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
    return buildCursorFromRow(contextRow, this.#paginationOrderBy(), direction);
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

    // Null-prototype: aliases and JSON-pointer segments are caller data, and a
    // "__proto__" key on an ordinary object would WRITE INTO Object.prototype
    // (global pollution) instead of creating an entry. See
    // store/transaction-receipt.ts createCountBucket for the same rule.
    const cursorContext: Record<string, unknown> = Object.create(
      null,
    ) as Record<string, unknown>;

    for (const spec of this.#paginationOrderBy()) {
      const alias = spec.field.alias;
      const jsonPointer = spec.field.jsonPointer;

      // System field order spec (e.g., path=["id"], no jsonPointer)
      if (jsonPointer === undefined) {
        if (spec.field.path.length !== 1) {
          throw new MissingSelectiveFieldError(alias, "orderBy");
        }
        const fieldName = requireDefined(spec.field.path[0]);
        const outputName = outputNameByAliasField.get(
          `${alias}\u0000${fieldName}`,
        );
        if (outputName === undefined) {
          throw new MissingSelectiveFieldError(alias, fieldName);
        }

        const aliasObject = this.#getOrCreateAliasObject(cursorContext, alias);
        aliasObject[fieldName] = nullToUndefined(row[outputName]);
        continue;
      }

      const segments = parseJsonPointer(jsonPointer);
      if (segments.length === 0) {
        throw new MissingSelectiveFieldError(alias, "orderBy");
      }

      const topField = requireDefined(segments[0]);
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

      const aliasObject = this.#getOrCreateAliasObject(cursorContext, alias);

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
        const segment = requireDefined(segments[index]);
        const existing_ = current[segment];
        if (typeof existing_ === "object" && existing_ !== null) {
          current = existing_ as Record<string, unknown>;
        } else {
          const created: Record<string, unknown> = Object.create(
            null,
          ) as Record<string, unknown>;
          current[segment] = created;
          current = created;
        }
      }
      current[requireDefined(segments.at(-1))] = decoded;
    }

    return cursorContext;
  }

  #getOrCreateAliasObject(
    cursorContext: Record<string, unknown>,
    alias: string,
  ): Record<string, unknown> {
    const existing = cursorContext[alias];
    if (typeof existing === "object" && existing !== null) {
      return existing as Record<string, unknown>;
    }
    const created: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    cursorContext[alias] = created;
    return created;
  }

  #getNodeKindNamesForAlias(alias: string): readonly string[] | undefined {
    if (alias === this.#state.startAlias) {
      return this.#state.startKinds;
    }
    return this.#state.traversals.find((t) => t.nodeAlias === alias)?.nodeKinds;
  }

  /**
   * The ORDER BY used for keyset pagination: the caller's ORDER BY plus a final
   * identity tiebreaker on the start alias. Without a unique final key, a
   * non-unique sort (e.g. `orderBy("p", "age")` with many equal ages) makes the
   * keyset predicate `age > lastAge` skip every not-yet-returned equal-age row,
   * silently losing data across pages. For a multi-kind start, identity is
   * `(kind, id)`; each missing component is appended after the caller's order.
   * For a single-kind start, `id` alone remains sufficient. The emitted sort,
   * cursor predicate, cursor encoding, and cursor validation all use this order,
   * including the selective-field-optimized path.
   */
  #paginationOrderBy(): readonly (Omit<OrderSpec, "field"> & {
    field: FieldRef;
  })[] {
    const orderBy = this.#state.orderBy.map((order) => ({
      ...order,
      field: requireCursorField(order.field),
    }));
    const startAlias = this.#state.startAlias;
    function hasSystemOrder(fieldName: "kind" | "id"): boolean {
      return orderBy.some(
        (spec) =>
          spec.field.alias === startAlias &&
          spec.field.path.length === 1 &&
          spec.field.path[0] === fieldName &&
          spec.field.jsonPointer === undefined,
      );
    }
    const missingKind =
      this.#state.startKinds.length > 1 && !hasSystemOrder("kind");
    const missingId = !hasSystemOrder("id");
    if (!missingKind && !missingId) return orderBy;
    function tiebreaker(fieldName: "kind" | "id"): OrderSpec & {
      field: FieldRef;
    } {
      return {
        field: {
          __type: "field_ref",
          alias: startAlias,
          nullable: false,
          path: [fieldName],
          valueType: "string",
        },
        direction: "asc",
      };
    }
    return [
      ...orderBy,
      ...(missingKind ? [tiebreaker("kind")] : []),
      ...(missingId ? [tiebreaker("id")] : []),
    ];
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
    this.#refuseCheckedReadSurface("paginate");
    validatePaginationOptions(this.#state, options);
    if (this.#hasParameterReferences())
      throw new ConfigurationError(
        "Cursor pagination requires bound values, not param() references.",
        { operation: "paginate" },
      );
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
    const limit = options.first ?? options.last ?? DEFAULT_PAGINATION_LIMIT;
    const cursor = options.after ?? options.before;

    // Decode and validate cursor if provided
    let cursorData: CursorData | undefined;
    if (cursor) {
      cursorData = decodeCursor(cursor);
      validateCursorColumns(cursorData, this.#paginationOrderBy());
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
    const data = mapResults<Aliases, EdgeAliases, R, RecursiveAliases>(
      orderedRows,
      this.#state.startAlias,
      this.#state.traversals,
      this.#selectFn,
    );

    // Build paginated result with cursors
    return buildPaginatedResult(
      data,
      orderedRows,
      this.#paginationOrderBy(),
      limit,
      hasMore,
      isBackward,
      cursor,
      (row) =>
        buildSelectContext<Aliases, EdgeAliases, RecursiveAliases>(
          row,
          this.#state.startAlias,
          this.#state.traversals,
        ),
    );
  }

  /**
   * Builds a cold cursor-page read that can execute independently or as one
   * member of `store.batchOnce()`.
   */
  page(
    options: PaginateOptions,
  ): CompiledOneStatementRead<PaginatedResult<R>> &
    Required<Pick<OneStatementBatchableQuery<PaginatedResult<R>>, "execute">> {
    this.#refuseCheckedReadSurface("page");
    const pageOptions = { ...options };
    validatePaginationOptions(this.#state, pageOptions);
    if (this.#hasParameterReferences())
      throw new ConfigurationError(
        "Cursor pagination requires bound values, not param() references.",
        { operation: "page" },
      );
    if (!this.#config.backend) {
      throw new Error(
        "Cannot build page read: no backend configured. " +
          "Use store.query() or pass a backend to createQueryBuilder().",
      );
    }
    if (this.#state.orderBy.length === 0) {
      throw new ValidationError(
        "Cursor pagination requires ORDER BY. Add .orderBy() before .page()",
        {
          issues: [
            {
              path: "orderBy",
              message: "ORDER BY is required for cursor pagination",
            },
          ],
        },
        {
          suggestion: `Add .orderBy(alias, field) before .page() to specify sort order.`,
        },
      );
    }

    const isBackward =
      pageOptions.last !== undefined || pageOptions.before !== undefined;
    const pageLimit =
      pageOptions.first ?? pageOptions.last ?? DEFAULT_PAGINATION_LIMIT;
    const cursor = pageOptions.after ?? pageOptions.before;
    const paginationOrderBy = this.#paginationOrderBy();
    const cursorData = cursor === undefined ? undefined : decodeCursor(cursor);
    if (cursorData !== undefined)
      validateCursorColumns(cursorData, paginationOrderBy);
    const direction = isBackward ? "backward" : "forward";
    const orderBy = adjustOrderByForDirection(paginationOrderBy, direction);
    const predicates =
      cursorData === undefined ?
        this.#state.predicates
      : [
          ...this.#state.predicates,
          buildCursorPredicate(
            cursorData,
            paginationOrderBy,
            direction,
            this.#state.startAlias,
          ),
        ];
    const pagedQuery = new ExecutableQuery(
      this.#config,
      {
        ...this.#state,
        predicates,
        orderBy,
        limit: pageLimit + 1,
        offset: undefined,
      },
      this.#selectFn,
    );

    return {
      execute: () => this.paginate(pageOptions),
      compileOneStatementBatchItem: () => {
        const item = requireDefined(
          pagedQuery.compileOneStatementBatchItem?.(),
        );
        const cursorOutputNames = orderBy.map((_spec, index) =>
          oneStatementBatchOrderColumn(index),
        );
        function cursorFromRow(
          row: Record<string, unknown>,
          cursorDirection: "f" | "b",
        ): string {
          return buildCursorFromValues(
            cursorOutputNames.map((outputName) => row[outputName]),
            paginationOrderBy,
            cursorDirection,
          );
        }
        return {
          ...item,
          hiddenOutputNames: cursorOutputNames,
          mapRows: (rows: readonly Record<string, unknown>[]) => {
            const hasMore = rows.length > pageLimit;
            const fetchedRows = hasMore ? rows.slice(0, pageLimit) : rows;
            const orderedRows =
              isBackward ? fetchedRows.toReversed() : fetchedRows;
            const data = item.mapRows(orderedRows);
            return buildPaginatedResultFromRows(
              data,
              orderedRows,
              hasMore,
              isBackward,
              cursor,
              (row, cursorDirection) => cursorFromRow(row, cursorDirection),
            );
          },
        };
      },
    };
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
    this.#refuseCheckedReadSurface("stream");
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

  #refuseCheckedReadSurface(surface: "page" | "paginate" | "stream"): void {
    if (
      getQueryBuilderInternalContext(this.#config).expectedSchemaVersion ===
      undefined
    ) {
      return;
    }
    throw new ConfigurationError(
      `${surface === "stream" ? "Streaming" : "Pagination"} is unavailable inside withCheckedReads().`,
      { operation: `withCheckedReads.${surface}` },
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

    const orderBy = adjustOrderByForDirection(
      this.#paginationOrderBy(),
      direction,
    );

    // Build cursor predicates if we have cursor data
    let predicates = [...this.#state.predicates];
    if (cursorData) {
      const cursorPredicate = buildCursorPredicate(
        cursorData,
        this.#paginationOrderBy(),
        direction,
        this.#state.startAlias,
      );
      predicates = [...predicates, cursorPredicate];
    }

    // Apply modified ORDER BY, predicates, and limit to AST (discard offset)
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
      await this.#requireBackend().execute<Record<string, unknown>>(compiled);
    const dialect = this.#config.dialect ?? "sqlite";
    return transformPathColumns(rawRows, this.#state, dialect);
  }
}
