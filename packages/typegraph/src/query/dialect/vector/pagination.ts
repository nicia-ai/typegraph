/**
 * Shared vector-search pagination clause.
 *
 * Every vector strategy pages its ordered relevance scan the same way: emit a
 * bare `LIMIT` for the first page (`offset` unset or `0`), and `LIMIT … OFFSET`
 * only when a non-zero offset must discard the leading rows. The three engines'
 * `buildSearch` methods each repeated this ternary verbatim; it lives here once
 * so the emitted clause can never drift between dialects.
 *
 * `limit` and `offset` ride as bound parameters (never interpolated), so the
 * clause — string and bound values alike — is identical across engines.
 */
import { sql, type SqlFragment } from "../../sql-fragment";

export function vectorPageClause(limit: number, offset?: number): SqlFragment {
  return offset === undefined || offset === 0 ?
      sql`LIMIT ${limit}`
    : sql`LIMIT ${limit} OFFSET ${offset}`;
}
