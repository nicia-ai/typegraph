/**
 * UnionableQuery - A query formed by combining multiple queries with set operations.
 */
import { type SQL } from "drizzle-orm";

import { type GraphDef } from "../../core/define-graph";
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
import {
  type AliasMap,
  type EdgeAliasMap,
  type QueryBuilderConfig,
  type SelectContext,
} from "./types";

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
    const ast: SetOperation = {
      __type: "set_operation",
      operator: this.#state.operator,
      left: this.#state.left,
      right: this.#state.right,
    };
    if (this.#state.limit !== undefined) {
      (ast as { limit?: number }).limit = this.#state.limit;
    }
    if (this.#state.offset !== undefined) {
      (ast as { offset?: number }).offset = this.#state.offset;
    }
    return ast;
  }

  /**
   * Compiles the set operation to SQL.
   */
  compile(): SQL {
    return compileSetOperation(
      this.toAst(),
      this.#config.graphId,
      this.#compileOptions(),
    );
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
   * Executes the combined query.
   */
  async execute(): Promise<readonly R[]> {
    if (!this.#config.backend) {
      throw new Error(
        "Cannot execute query: no backend configured. " +
          "Use store.query() or pass a backend to createQueryBuilder().",
      );
    }

    const compiled = this.compile();
    const rows =
      await this.#config.backend.execute<Record<string, unknown>>(compiled);

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
}
