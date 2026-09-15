import { ConfigurationError } from "../errors";
import type { SortDirection } from "./ast";
import { sql, type SqlFragment } from "./sql-fragment";

/** Compiles one portable scalar ORDER BY term with explicit null placement. */
export function compileOrderTerm(
  expression: SqlFragment,
  direction: "asc" | "desc",
  nulls: "first" | "last",
): SqlFragment {
  validateOrderTokens(direction, nulls);
  const directionSql = direction === "asc" ? sql.raw("ASC") : sql.raw("DESC");
  const nullsSql =
    nulls === "first" ? sql.raw("NULLS FIRST") : sql.raw("NULLS LAST");
  return sql`${expression} ${directionSql} ${nullsSql}`;
}

/** Runtime AST input can bypass the TypeScript enum contract. */
function validateOrderTokens(direction: string, nulls: string): void {
  if (direction !== "asc" && direction !== "desc") {
    throw new ConfigurationError(`Invalid ORDER BY direction: ${direction}`);
  }
  if (nulls !== "first" && nulls !== "last") {
    throw new ConfigurationError(`Invalid ORDER BY null placement: ${nulls}`);
  }
}

/** Resolves the portable null placement for an ordering specification. */
export function resolveNullOrdering(
  order: Readonly<{
    direction: SortDirection;
    nulls?: "first" | "last" | undefined;
  }>,
): "first" | "last" {
  return order.nulls ?? (order.direction === "asc" ? "last" : "first");
}
