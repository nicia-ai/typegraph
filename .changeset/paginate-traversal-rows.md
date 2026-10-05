---
"@nicia-ai/typegraph": patch
---

**`paginate()`, `page()` and `stream()` no longer skip or repeat rows of a traversal query.** A traversal that fans one start node out into several rows produced rows that tied on the whole keyset, so every sibling of a page's last row was skipped; and an order key on a traversed alias (`orderBy("p", "name")` after `.to("Person", "p")`, the shape the pagination guide shows) was compared against the start node's row, which repeated or dropped pages. The keyset now identifies the result row — the start node's identity plus the `id` of the edge each traversal matched, so two parallel edges between one pair of nodes page as two rows — and the cursor is positioned against the completed match, where an order key may read the start node, a traversed node or an edge. An edge-alias order key also works for a `page()` read inside `batchOnce()`, which previously failed to compile.

Upgrade notes:

- A cursor saved from a traversal query is refused with the existing cursor-column `ValidationError`, because the keyset gained the edge keys. Restart that pagination from the first page. Cursors of queries with no traversal are unaffected.
- A query with a recursive traversal keeps the start-node keyset: it has no single edge per row. Its pages are exact only while no start node's rows straddle a page boundary.
