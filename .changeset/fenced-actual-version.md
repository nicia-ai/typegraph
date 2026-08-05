---
"@nicia-ai/typegraph": patch
---

Report the real active schema version in `StaleVersionError.details.actual` when
a PostgreSQL schema-managed write loses to a concurrent schema commit.

The write fence takes a `FOR SHARE` lock on the active schema row. At `read
committed`, a locking read that blocks behind an in-flight schema commit
rechecks only the row versions its own statement snapshot saw — so once the
winner marked the old row inactive, the fence saw no active row at all and
reported `actual: 0`, misrepresenting the database as having no active schema.
The fence now settles an empty locked read with a non-locking read, which
observes the committed winner, and reports `0` only when a graph genuinely has
no active version. The write itself was always correctly rejected; only the
error metadata was wrong.
