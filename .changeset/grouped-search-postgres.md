---
"@nicia-ai/typegraph": patch
---

A query that aggregates rows and carries a full-text, vector or hybrid predicate now runs on PostgreSQL and returns the same groups, in the same order, on every backend (#968). Every search statement appends a relevance ORDER BY (`rank DESC`, `distance ASC`, or the fused RRF score with a `node_id` tiebreak) that reads a per-match column. In a statement whose rows are groups (`groupBy()`, an ungrouped `aggregate()`, or a `project()` with an aggregate), PostgreSQL refused it (`column "cte_fulltext.rank" must appear in the GROUP BY clause`, likewise `cte_embeddings.distance` and `cte_embeddings.ord`), and SQLite ordered the groups by an arbitrary member's relevance. Such a statement now orders each group by its best member: `MAX(rank)`, `MIN(distance)`, `MAX` of the fused score, with `MIN` of the `node_id` tiebreak. The caller's `orderBy()` terms follow as tiebreakers, as in an ungrouped search.

The relevance ORDER BY also dropped `orderBy()` terms that name an `aggregate()` or `project()` output, so `.aggregate({ n: count("a") }).orderBy("n", "asc")` on a search query ignored the requested order on every backend. Those terms are now applied. Search queries that do not aggregate compile to the same SQL as before.
