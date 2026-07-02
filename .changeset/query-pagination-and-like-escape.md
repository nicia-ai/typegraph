---
"@nicia-ai/typegraph": patch
---

Fix two silent query-correctness bugs. Keyset pagination (`paginate`/`stream`)
now appends a unique `id` tiebreaker to the ORDER BY so a non-unique sort no
longer drops equal-key rows across pages. And every compiled `LIKE`/`ILIKE` now
emits `ESCAPE '\'` — including the case-sensitive `like` path, which previously
omitted it — so escaped `%`/`_`/`\` match literally on SQLite as they already
did on PostgreSQL, in both the auto-escaped operators
(`contains`/`startsWith`/`endsWith`) and raw `like`/`ilike` patterns, and
whether the pattern is a literal or a bound parameter (previously SQLite had no
default LIKE escape character, so the two backends — and the direct vs prepared
paths — diverged).
