---
"@nicia-ai/typegraph": patch
---

**Critical fix**: `.prepare()`d queries, and any `ExecutableQuery`/`UnionableQuery`/`ExecutableAggregateQuery` instance whose `.execute()` was called more than once, could silently miss rows created after the query was first compiled.

A "current" (live) temporal-validity read binds its read instant (`currentReadInstant()`) at SQL compile time. All four query-builder classes cached their compiled SQL text across calls — `.prepare()` compiled once and every subsequent `execute({...})` reused that same SQL text, and a reused `ExecutableQuery`/`UnionableQuery`/`ExecutableAggregateQuery` instance cached its first `.execute()`'s compilation the same way. Both patterns froze "now" at the moment of first compilation: any row created afterward had a `valid_from` later than the frozen instant, so `valid_from <= now` silently evaluated to false for it, for the query's entire remaining lifetime.

This is a regression introduced by the `current-read-app-clock` fix (the #242 clock-skew correction): the prior behavior (`NOW()` / `strftime('now')`, evaluated fresh by the database on every execution) did not have this problem. It is more severe than #242 — that bug required app/DB clock skew across separate hosts; this one reproduces unconditionally, in a single process, on the very next insert after a query is prepared or first executed. `.prepare()`-once-`.execute()`-many is this library's own documented, recommended pattern, so this affected the common case, not an edge case.

**Fix**: none of the four classes cache compiled SQL text across calls anymore — each `execute()`/`compile()`/`toSQL()` call recompiles fresh, so `currentReadInstant()` is re-evaluated every time. `.prepare()` still builds and structurally validates the query AST once (so a malformed query still fails fast, before the first `execute()`); only the SQL-text compilation moved from prepare-time to each execute-time call. `param()`-bound values are unaffected — those were already correctly re-bound per call.
