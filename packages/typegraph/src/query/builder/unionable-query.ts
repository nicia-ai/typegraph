/**
 * UnionableQuery - A query formed by combining multiple queries with set operations.
 */
import {
  type GraphBackend,
  type TransactionBackend,
} from "../../backend/types";
import { type GraphDef } from "../../core/define-graph";
import { withRecordedRelationsPrecondition } from "../../utils/sql-errors";
import {
  type ComposableQuery,
  type QueryAst,
  type SetOperation,
  type SetOperationType,
  type Traversal,
} from "../ast";
import {
  type CompileQueryOptions,
  compileSetOperation,
} from "../compiler/index";
import { mapResults } from "../execution";
import { type CompiledSelectSql } from "../sql-intent";
import { buildCompileOptions } from "./compile-options";
import { composableQueryHasParameterReferences } from "./prepared-query";
import {
  type AliasMap,
  type EdgeAliasMap,
  type QueryBuilderConfig,
  type SelectContext,
} from "./types";

function executeOnBackend<T>(
  backend: GraphBackend | TransactionBackend,
  recordedAsOf: string | undefined,
  promise: Promise<T>,
  surface: string,
): Promise<T> {
  if (recordedAsOf === undefined) return promise;
  return withRecordedRelationsPrecondition(promise, {
    dialect: backend.dialect,
    surface,
  });
}

function recordedAsOfForComposableQuery(
  query: ComposableQuery,
): string | undefined {
  if ("__type" in query) {
    return (
      recordedAsOfForComposableQuery(query.left) ??
      recordedAsOfForComposableQuery(query.right)
    );
  }
  return query.recordedAsOf;
}

// Forward declaration for ExecutableQuery to avoid circular imports
// G and R are used for type compatibility with ExecutableQuery but not accessed in the interface body
interface ExecutableQueryLike<
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Used for type compatibility
  G extends GraphDef,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Used for type compatibility
  R,
> {
  toAst(): QueryAst;
}

/**
 * Internal state for unionable query.
 */
type UnionableQueryState = Readonly<{
  left: ComposableQuery;
  operator: SetOperationType;
  right: ComposableQuery;
  limit?: number;
  offset?: number;
  // For result transformation
  startAlias?: string;
  traversals?: readonly Traversal[];
  selectFn?: (context: SelectContext<AliasMap, EdgeAliasMap>) => unknown;
}>;

/**
 * A query formed by combining multiple queries with set operations.
 * Supports chaining: q1.union(q2).intersect(q3)
 */
export class UnionableQuery<G extends GraphDef, R> {
  readonly #config: QueryBuilderConfig;
  readonly #state: UnionableQueryState;

  constructor(config: QueryBuilderConfig, state: UnionableQueryState) {
    this.#config = config;
    this.#state = state;
  }

  /**
   * Combines with another query using UNION.
   */
  union(other: ExecutableQueryLike<G, R>): UnionableQuery<G, R> {
    return new UnionableQuery(this.#config, {
      left: this.toAst(),
      operator: "union",
      right: other.toAst(),
      // Preserve result transformation info (only include defined properties)
      ...(this.#state.startAlias !== undefined && {
        startAlias: this.#state.startAlias,
      }),
      ...(this.#state.traversals !== undefined && {
        traversals: this.#state.traversals,
      }),
      ...(this.#state.selectFn !== undefined && {
        selectFn: this.#state.selectFn,
      }),
    });
  }

  /**
   * Combines with another query using UNION ALL.
   */
  unionAll(other: ExecutableQueryLike<G, R>): UnionableQuery<G, R> {
    return new UnionableQuery(this.#config, {
      left: this.toAst(),
      operator: "unionAll",
      right: other.toAst(),
      // Preserve result transformation info (only include defined properties)
      ...(this.#state.startAlias !== undefined && {
        startAlias: this.#state.startAlias,
      }),
      ...(this.#state.traversals !== undefined && {
        traversals: this.#state.traversals,
      }),
      ...(this.#state.selectFn !== undefined && {
        selectFn: this.#state.selectFn,
      }),
    });
  }

  /**
   * Combines with another query using INTERSECT.
   */
  intersect(other: ExecutableQueryLike<G, R>): UnionableQuery<G, R> {
    return new UnionableQuery(this.#config, {
      left: this.toAst(),
      operator: "intersect",
      right: other.toAst(),
      // Preserve result transformation info (only include defined properties)
      ...(this.#state.startAlias !== undefined && {
        startAlias: this.#state.startAlias,
      }),
      ...(this.#state.traversals !== undefined && {
        traversals: this.#state.traversals,
      }),
      ...(this.#state.selectFn !== undefined && {
        selectFn: this.#state.selectFn,
      }),
    });
  }

  /**
   * Combines with another query using EXCEPT.
   */
  except(other: ExecutableQueryLike<G, R>): UnionableQuery<G, R> {
    return new UnionableQuery(this.#config, {
      left: this.toAst(),
      operator: "except",
      right: other.toAst(),
      // Preserve result transformation info (only include defined properties)
      ...(this.#state.startAlias !== undefined && {
        startAlias: this.#state.startAlias,
      }),
      ...(this.#state.traversals !== undefined && {
        traversals: this.#state.traversals,
      }),
      ...(this.#state.selectFn !== undefined && {
        selectFn: this.#state.selectFn,
      }),
    });
  }

  /**
   * Limits the number of results from the combined query.
   */
  limit(n: number): UnionableQuery<G, R> {
    return new UnionableQuery(this.#config, { ...this.#state, limit: n });
  }

  /**
   * Offsets the results from the combined query.
   */
  offset(n: number): UnionableQuery<G, R> {
    return new UnionableQuery(this.#config, { ...this.#state, offset: n });
  }

  /**
   * Builds the set operation AST.
   */
  toAst(): SetOperation {
    return {
      __type: "set_operation",
      operator: this.#state.operator,
      left: this.#state.left,
      right: this.#state.right,
      ...(this.#state.limit !== undefined && { limit: this.#state.limit }),
      ...(this.#state.offset !== undefined && { offset: this.#state.offset }),
    };
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
   * Compiles the set operation to SQL.
   */
  compile(): CompiledSelectSql {
    // Not cached — a "current" temporal filter binds its read instant at
    // compile time, so caching across calls would freeze "now" at first
    // compilation (see PreparedQuery's class doc comment for the full
    // rationale).
    return compileSetOperation(
      this.toAst(),
      this.#config.graphId,
      this.#compileOptions(),
    );
  }

  #compileOptions(): CompileQueryOptions {
    return buildCompileOptions(this.#config);
  }

  /**
   * Executes the combined query.
   */
  async execute(): Promise<readonly R[]> {
    if (!this.#config.backend) {
      throw new Error(
        "Cannot execute query: no backend configured. " +
          "Use store.query() or pass a backend to createQueryBuilder().",
      );
    }
    const backend = this.#config.backend;

    const ast = this.toAst();
    if (composableQueryHasParameterReferences(ast)) {
      throw new Error(
        "Query contains param() references. Use .prepare().execute({...}) instead of .execute().",
      );
    }

    const compiled = this.compile();
    const rows = await executeOnBackend(
      backend,
      recordedAsOfForComposableQuery(ast),
      backend.execute<Record<string, unknown>>(compiled),
      "recorded-query",
    );

    // Apply select function transformation if available
    if (this.#state.selectFn && this.#state.startAlias) {
      return mapResults(
        rows,
        this.#state.startAlias,
        this.#state.traversals ?? [],
        this.#state.selectFn,
      ) as readonly R[];
    }

    return rows as readonly R[];
  }

  /**
   * Executes the combined query against a provided backend.
   *
   * Used by `store.batch()` to run multiple queries over a single connection.
   */
  async executeOn(
    backend: GraphBackend | TransactionBackend,
  ): Promise<readonly R[]> {
    const ast = this.toAst();
    if (composableQueryHasParameterReferences(ast)) {
      throw new Error(
        "Query contains param() references. Use .prepare().execute({...}) instead of .execute().",
      );
    }

    const compiled = this.compile();
    const recordedAsOf = recordedAsOfForComposableQuery(ast);
    const rows = await executeOnBackend(
      backend,
      recordedAsOf,
      backend.execute<Record<string, unknown>>(compiled),
      "recorded-batch-query",
    );

    if (this.#state.selectFn && this.#state.startAlias) {
      return mapResults(
        rows,
        this.#state.startAlias,
        this.#state.traversals ?? [],
        this.#state.selectFn,
      ) as readonly R[];
    }

    return rows as readonly R[];
  }
}
