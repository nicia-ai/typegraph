---
"@nicia-ai/typegraph": patch
---

A full-text, vector or hybrid query now selects the same rows and groups through every terminal (#974). `execute()` orders such a query by relevance first and by the caller's `orderBy()` terms second. The terminals that wrap the statement in another one ordered it by the caller's terms alone, so they could select a different row or group. These were `first()`, `executeOn()`, `prepare()`, `count()` and `exists()` of an aggregate query, `store.batchOnce()` for aggregate, `project()` and `select()` queries, and `asRelation()`. For example, `.groupBy("a", "category").aggregate({ category, n: count("a") }).orderBy("n", "desc").first()` returned the largest group rather than the most relevant one.

A search statement read by another statement now carries one hidden column: the `RANK()` of each row under exactly the terms of its own ORDER BY, including the best-member relevance keys of a grouped statement. The relation over the query and the `batchOnce()` row numbering order by that column, so every terminal selects the rows `execute()` selects, limits and offsets included. The column is a select-list term rather than a projected field, so it never becomes a grouping key, and it compiles in the statement's own scope, so ordering by an edge field still works. Statements run directly through `execute()`, and every query without a search predicate, compile to the same SQL as before.

On a relation built from a search query, an `orderBy()` added after `asRelation()` breaks ties in relevance, as the same term added to the query's ORDER BY would. `distinct()` and a relation `groupBy()` order each distinct row or group by its most relevant occurrence, and `page()` / `stream()` lead with that order before the projected columns.
