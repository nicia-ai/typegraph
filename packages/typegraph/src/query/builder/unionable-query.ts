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
  buildReadInstantTemplate,
  type CompiledTemplate,
  composableNeedsCurrentReadInstant,
  fillTemplateParams,
} from "./read-instant-template";
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
/** Sentinel distinguishing "template not yet built" from a built `undefined`. */
const NOT_COMPUTED = Symbol("NOT_COMPUTED");

export class UnionableQuery<G extends GraphDef, R> {
  readonly #config: QueryBuilderConfig;
  readonly #state: UnionableQueryState;
  // Per-instance compiled placeholder template, reused across
  // execute()/executeOn() calls; the read instant is filled fresh per call.
  // NOT_COMPUTED = not yet built; undefined = no fast path.
  #template: CompiledTemplate | typeof NOT_COMPUTED | undefined = NOT_COMPUTED;

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
    // Emits a directly-runnable statement with the read instant as a literal;
    // this is not the reusable placeholder template execute() caches (see
    // #resolveTemplate).
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
   * The cached placeholder template for this set operation, or `undefined`
   * when no fast path applies. Built once per instance; every operand's read
   * instant is the shared placeholder, filled fresh per execution by
   * {@link fillTemplateParams}.
   */
  #resolveTemplate(ast: SetOperation): CompiledTemplate | undefined {
    if (this.#template !== NOT_COMPUTED) return this.#template;
    this.#template = buildReadInstantTemplate({
      compile: () =>
        compileSetOperation(ast, this.#config.graphId, {
          ...this.#compileOptions(),
          readInstant: "placeholder",
        }),
      backend: this.#config.backend,
      needsReadInstant: composableNeedsCurrentReadInstant(ast),
    });
    return this.#template;
  }

  /**
   * Fetches raw rows for the set operation: cached template + `executeRaw`
   * when available, else a fresh literal compile via `backend.execute`.
   */
  async #fetchRows(
    backend: GraphBackend | TransactionBackend,
    ast: SetOperation,
    surface: string,
  ): Promise<readonly Record<string, unknown>[]> {
    const executeRaw = backend.executeRaw;
    const template =
      executeRaw === undefined ? undefined : this.#resolveTemplate(ast);
    return executeOnBackend(
      backend,
      recordedAsOfForComposableQuery(ast),
      template !== undefined && executeRaw !== undefined ?
        // Method call (not the detached `executeRaw` local) so a this-using
        // backend implementation keeps its receiver.
        backend.executeRaw!<Record<string, unknown>>(
          template.sql,
          fillTemplateParams(
            template.params,
            {},
            this.#config.dialect ?? "sqlite",
          ),
        )
      : backend.execute<Record<string, unknown>>(
          compileSetOperation(
            ast,
            this.#config.graphId,
            this.#compileOptions(),
          ),
        ),
      surface,
    );
  }

  /** Applies the select-function transformation, if one is attached. */
  #mapRows(rows: readonly Record<string, unknown>[]): readonly R[] {
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

    return this.#mapRows(await this.#fetchRows(backend, ast, "recorded-query"));
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

    return this.#mapRows(
      await this.#fetchRows(backend, ast, "recorded-batch-query"),
    );
  }
}
