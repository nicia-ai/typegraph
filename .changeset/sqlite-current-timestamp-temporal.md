---
"@nicia-ai/typegraph": patch
---

Fix SQLite temporal filter timestamp format in graph algorithms and subgraph.

`buildReachableCte`, `resolveTemporalFilter`, and `fetchSubgraphEdges` compiled
temporal filters without passing `dialect.currentTimestamp()`, so on SQLite they
fell back to raw `CURRENT_TIMESTAMP` (`YYYY-MM-DD HH:MM:SS`). Stored
`valid_from` / `valid_to` use ISO-8601 (`YYYY-MM-DDTHH:MM:SS.sssZ`), and because
`T` sorts above space, same-day ISO timestamps compare incorrectly against raw
`CURRENT_TIMESTAMP`. Under `temporalMode: "current"` this caused
`reachable` / `canReach` / `neighbors` / `shortestPath` / `degree` and the
`subgraph` edge hydration to misclassify rows whose `valid_from` or `valid_to`
fell on today's date, disagreeing with `store.query()` and collection reads.

All three call sites now inject the dialect-specific current timestamp
(`strftime('%Y-%m-%dT%H:%M:%fZ','now')` on SQLite, `NOW()` on PostgreSQL),
matching the query compiler.
