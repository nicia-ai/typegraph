---
"@nicia-ai/typegraph": patch
---

Validate set-operation leaf vector predicates against the configured vector
strategy rather than only the dialect's fallback metric list, so a custom
strategy's metric (e.g. `inner_product` on SQLite) is accepted inside
`UNION`/`INTERSECT`/`EXCEPT` leaves exactly as it is in a standalone query.

Reject a per-query fulltext `language` override on the query-builder path
(`.$fulltext.matches(..., { language })`) when the strategy's tokenizer is fixed
at table-create time (SQLite/FTS5), matching the store-level search guard
instead of silently ignoring the option.
