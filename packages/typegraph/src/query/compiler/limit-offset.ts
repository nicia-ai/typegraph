import type { DialectAdapter } from "../dialect/types";
import { sql, type SqlFragment } from "../sql-fragment";

/** SQL bounds, including the engine's unbounded LIMIT token for an offset-only query. */
export function compileLimitOffsetClauses(
  limit: number | undefined,
  offset: number | undefined,
  dialect: DialectAdapter,
): readonly SqlFragment[] {
  return [
    ...(limit === undefined ? [] : [sql`LIMIT ${limit}`]),
    ...(offset === undefined ?
      []
    : [
        limit === undefined ?
          sql`LIMIT ${dialect.unboundedLimit()} OFFSET ${offset}`
        : sql`OFFSET ${offset}`,
      ]),
  ];
}
