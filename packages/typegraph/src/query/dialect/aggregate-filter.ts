import { sql, type SqlFragment } from "../sql-fragment";

/** Applies the portable SQL aggregate filter contract when a filter is present. */
export function applyAggregateFilter(
  aggregate: SqlFragment,
  filter: SqlFragment | undefined,
): SqlFragment {
  return filter === undefined ? aggregate : (
      sql`${aggregate} FILTER (WHERE ${filter})`
    );
}
