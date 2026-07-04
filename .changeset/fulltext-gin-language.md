---
"@nicia-ai/typegraph": patch
---

perf: PostgreSQL fulltext queries are now parsed with the kind's DECLARED language as a plan-time constant (the same winning-language rule the write path applies to rows), instead of referencing the per-row `language` column. The per-row form made every tsquery non-constant, so the GIN index on `tsv` could never serve a match and every search re-parsed the query per row — measured 12.9ms → 2.3ms at 5,000 docs for the parse elimination alone, with GIN service now possible as corpora grow. Applies to the facade and the inline `$fulltext` predicate; mixed-language subclass aliases and explicit per-query overrides behave as before.
