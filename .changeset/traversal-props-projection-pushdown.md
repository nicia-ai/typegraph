---
"@nicia-ai/typegraph": patch
---

perf: push selected top-level `props` field extractions into the
start/traversal CTEs instead of carrying the whole raw `props` JSONB/JSON
column outward for later extraction at the final projection. Each
selected field is extracted once, inline, as its own typed CTE column
(named from a length-prefixed encoding of its alias and field, so
distinct alias/field pairs can never collide on the same column name);
the outer projection and any matching `ORDER BY` on the same field just
reference that column directly instead of re-extracting from a
carried-forward `<alias>_props` column.

Found while investigating why a covering index on a system column (see
`keySystemColumns`) still couldn't get Postgres to serve an indexed join
index-only: the compiled query was asking for the entire `props` column
in the join step even though the final `.select()` only needed one
extracted field, so the specific indexed expression was never actually
what got read from the table. No behavior change: compiled query results
are identical; this only changes which columns each CTE carries and
where field extraction happens.
