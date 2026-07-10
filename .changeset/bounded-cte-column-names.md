---
"@nicia-ai/typegraph": patch
---

Fix: the synthetic CTE column names that carry selectively-extracted `props`
fields are now bounded to PostgreSQL's identifier limit.

A selected top-level `props` field is extracted once inside the CTE that owns it,
under a generated column name encoding the query alias and the field name. The
encoding was unambiguous but unbounded, and PostgreSQL silently truncates
identifiers at 63 **bytes** — so two distinct `(alias, field)` pairs sharing a
long prefix could collapse onto one column name after truncation, yielding an
ambiguous-column error or the wrong value.

Long names are now truncated on a UTF-8 character boundary and disambiguated with
a hash of the full, untruncated pair — the same guard the sibling subgraph
projection path already used, now extracted into one shared helper. Names that
already fit are emitted unchanged, so compiled SQL for ordinary queries is
byte-for-byte what it was.
