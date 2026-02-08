/**
 * ExecutableAggregateQuery - A query with aggregate functions that can be executed.
 */
import { type SQL } from "drizzle-orm";

import { type GraphDef } from "../../core/define-graph";
import { type AggregateExpr, type FieldRef, type QueryAst } from "../ast";
import { compileQuery, type CompileQueryOptions } from "../compiler/index";
import { buildQueryAst } from "./ast-builder";
import {
  type AliasMap,
  type QueryBuilderConfig,
  type QueryBuilderState,
} from "./types";

/**
 * Result type for aggregate queries.
 * Maps field refs to their value types and aggregates to numbers.
 */
export type AggregateResult<
  R extends Record<string, FieldRef | AggregateExpr>,
> = {
  [K in keyof R]: R[K] extends AggregateExpr ? number
  : R[K] extends FieldRef ? unknown
  : never;
};

/**
 * An aggregate query that can be executed.
 */
export class ExecutableAggregateQuery<
  G extends GraphDef,
  Aliases extends AliasMap,
  R extends Record<string, FieldRef | AggregateExpr>,
> {
  readonly #config: QueryBuilderConfig;
  readonly #state: QueryBuilderState;
  readonly #fields: R;

  constructor(config: QueryBuilderConfig, state: QueryBuilderState, fields: R) {
    this.#config = config;
    this.#state = state;
    this.#fields = fields;
  }

  /**
   * Builds the query AST.
   */
  toAst(): QueryAst {
    return buildQueryAst(this.#config, this.#state);
  }

  /**
   * Limits the number of results.
   */
  limit(n: number): ExecutableAggregateQuery<G, Aliases, R> {
    return new ExecutableAggregateQuery(
      this.#config,
      { ...this.#state, limit: n },
      this.#fields,
    );
  }

  /**
   * Offsets the results.
   */
  offset(n: number): ExecutableAggregateQuery<G, Aliases, R> {
    return new ExecutableAggregateQuery(
      this.#config,
      { ...this.#state, offset: n },
      this.#fields,
    );
  }

  /**
   * Compiles the query to a Drizzle SQL object.
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
   * @throws Error if no backend is configured
   */
  async execute(): Promise<readonly AggregateResult<R>[]> {
    if (!this.#config.backend) {
      throw new Error(
        "Cannot execute query: no backend configured. " +
          "Use store.query() or pass a backend to createQueryBuilder().",
      );
    }

    const compiled = this.compile();
    const rows =
      await this.#config.backend.execute<Record<string, unknown>>(compiled);

    return this.#mapResults(rows);
  }

  /**
   * Maps raw database rows to typed results.
   * Handles database-specific value conversions:
   * - PostgreSQL returns bigint/numeric as strings → convert to numbers
   * - SQLite returns JSON booleans as 0/1 numbers → convert to booleans
   * - PostgreSQL returns JSON booleans as "true"/"false" strings → convert to booleans
   */
  #mapResults(
    rows: readonly Record<string, unknown>[],
  ): readonly AggregateResult<R>[] {
    return rows.map((row) => {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(this.#fields)) {
        const field = this.#fields[key];
        if (!field) continue;
        const value = row[key];

        if (field.__type === "aggregate") {
          // PostgreSQL returns aggregate bigint/numeric as strings.
          result[key] = typeof value === "string" ? Number(value) : value;
          continue;
        }

        result[key] = normalizeFieldValue(field, value);
      }
      return result as AggregateResult<R>;
    });
  }
}

/**
 * Converts database-specific boolean encodings to JS booleans.
 *
 * - SQLite json_extract() returns 0/1 for JSON booleans
 * - PostgreSQL #>> returns "true"/"false" for JSON booleans
 */
function normalizeBooleanValue(value: unknown): unknown {
  if (value === null) return undefined;
  if (value === true || value === false) return value;
  if (value === 1) return true;
  if (value === 0) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "1") return true;
  if (value === "0") return false;
  return value;
}

function normalizeFieldValue(field: FieldRef, value: unknown): unknown {
  if (field.valueType === "boolean") {
    return normalizeBooleanValue(value);
  }

  return value === null ? undefined : value;
}
