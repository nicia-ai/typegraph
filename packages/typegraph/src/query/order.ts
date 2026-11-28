import { ConfigurationError } from "../errors";
import type { SortDirection } from "./ast";
import type { DialectAdapter } from "./dialect/types";
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

/**
 * The ordering term that sorts in exactly the opposite order: direction and
 * null placement both flipped. A backward cursor page reads its rows in this
 * order.
 */
export function reverseOrder<
  Order extends Readonly<{
    direction: SortDirection;
    nulls?: "first" | "last" | undefined;
  }>,
>(order: Order): Order & Readonly<{ nulls: "first" | "last" }> {
  return {
    ...order,
    direction: order.direction === "asc" ? "desc" : "asc",
    nulls: resolveNullOrdering(order) === "first" ? "last" : "first",
  };
}

/**
 * Where a full-text, vector or hybrid match whose relevance value is NULL
 * sorts: after every match with a value, as the least relevant, in both a
 * descending rank and an ascending distance. A cosine distance to a zero
 * embedding is NULL on SQLite (PostgreSQL computes NaN, which it sorts after
 * every number). The one owner of that placement: the statement's ORDER BY,
 * every top-k cut of a search (`compileRelevanceCandidateOrder`) and a keyset
 * cursor's position all read it.
 */
export const RELEVANCE_NULL_ORDERING = "last";

/**
 * The total order a top-k cut of search candidates takes its rows in: by
 * `value` in `direction`, NULLs last ({@link RELEVANCE_NULL_ORDERING}), then
 * by the candidate's identity, `nodeKind` and `nodeId` (a node id is unique
 * only within its kind, so a search over several kinds can tie two nodes
 * with one id). A cut inside a tie then keeps the same rows in every
 * statement, so every execution and every cursor page of one search ranks
 * the same candidates.
 *
 * The identity compares in byte order on every backend
 * (`dialect.binaryText`), as `store.search`'s own top-k cut breaks a tie,
 * not in a PostgreSQL database's collation: a linguistic collation orders
 * `a` before `B` where byte order and SQLite take `B` first, so the same
 * tie would keep a different candidate on each backend and API.
 *
 * `nodeKind` is `undefined` only for a cut over one kind's candidates (a
 * vector strategy's scan of one kind's table), where it is the same for
 * every row and orders nothing.
 */
export function compileRelevanceCandidateOrder(
  value: SqlFragment,
  direction: "asc" | "desc",
  identity: Readonly<{
    nodeKind: SqlFragment | undefined;
    nodeId: SqlFragment;
  }>,
  dialect: Pick<DialectAdapter, "binaryText">,
): SqlFragment {
  const kindTerm =
    identity.nodeKind === undefined ?
      sql``
    : sql`${dialect.binaryText(identity.nodeKind)} ASC, `;
  return sql`${compileOrderTerm(value, direction, RELEVANCE_NULL_ORDERING)}, ${kindTerm}${dialect.binaryText(identity.nodeId)} ASC`;
}
