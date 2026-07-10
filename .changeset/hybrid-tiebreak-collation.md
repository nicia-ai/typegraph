---
"@nicia-ai/typegraph": patch
---

Fix: hybrid search's two execution paths agreed on scores but not on ties, and
neither was deterministic across PostgreSQL databases.

Relevance ranking breaks a score tie on `node_id`. Left bare, PostgreSQL sorts
that under the database's default text collation: an `en_US.UTF-8` database
orders `a, A, b, B` where byte order gives `A, B, a, b`. So the same query
returned different pages on two databases whose `datcollate` differed, and
disagreed with SQLite (whose `BINARY` collation is byte order) throughout.

Three seams had to move together, because a hybrid search's tiebreak decides the
page twice — once in the per-source ranks, and again in the fused ordering the
ranks produce:

- The single-statement hybrid search now renders `node_id COLLATE "C"` in both
  per-source `ROW_NUMBER()` windows and in the final `ORDER BY`.
- The standalone fulltext search's `ORDER BY … , node_id` is C-collated too, so
  the multi-statement fallback's fulltext ranks match.
- The fallback now re-ranks each leg's rows before assigning ranks, rather than
  trusting the order the source SQL happened to return for a single kind. The
  vector source breaks a distance tie arbitrarily — it carries no `node_id`
  tiebreak, because a second sort key would cost pgvector its ordered index scan
  — so its arrival order was never a sound basis for a rank. That re-rank sorts
  with a new code-point comparator rather than JavaScript's UTF-16 code-unit
  `<`, which disagrees with byte order for astral characters such as emoji.

All three orderings now coincide, and the single-statement and multi-statement
paths return identical hits, ranks, and scores even when every score ties.

Results only change where they were previously non-deterministic.
