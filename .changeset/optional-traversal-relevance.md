---
"@nicia-ai/typegraph": patch
---

A `$fulltext.matches()`, `.similarTo()` or hybrid predicate on the target of an `optionalTraverse()` now keeps every start row, as an ordinary predicate on the same target does. A start row with no target, or whose targets all fail the search, comes back once with the optional side absent; a start row with a matching and a failing target comes back with the matching one only. The relevance relation used to be inner-joined after the optional join, which dropped those start rows. It is now joined inside the optional join (`LEFT JOIN (target INNER JOIN relevance) ON …`) on every backend.

In the relevance order, a row whose optional side is absent has no score and sorts after every matched row on every backend, with `orderBy()` breaking ties among such rows. This includes a fused score of zero under zero `fuseWith()` weights. `groupBy()` / `aggregate()`, `count()`, `exists()`, `first()`, `prepare()`, `executeOn()`, `store.batchOnce()` and `asRelation()` select the same rows in the same order. The SQL of a query whose searched alias is not an optional traversal's target is unchanged.

Upgrade note: a query that put a search predicate on an `optionalTraverse()` target and relied on it to drop start rows without a match now returns those rows with the optional side `undefined`. Use `traverse()` to keep only start rows with a matching target.
