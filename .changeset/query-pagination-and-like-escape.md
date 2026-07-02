---
"@nicia-ai/typegraph": patch
---

Fix two silent query-correctness bugs. Keyset pagination (`paginate`/`stream`)
now appends a unique `id` tiebreaker to the ORDER BY so a non-unique sort no
longer drops equal-key rows across pages. And every compiled `LIKE`/`ILIKE` now
emits `ESCAPE '\'`, so escaped `%`/`_`/`\` in `contains`/`startsWith`/`endsWith`
match literally on SQLite as they already did on PostgreSQL (previously SQLite
had no default LIKE escape character, so the two backends diverged).
