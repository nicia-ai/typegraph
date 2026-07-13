---
"@nicia-ai/typegraph": minor
---

`createLocalSqliteBackend`'s `pragmas` option accepts a new field:
`walAutocheckpointPages` (`PRAGMA wal_autocheckpoint`). Defaults to
`undefined`, leaving SQLite's own built-in default (1,000 pages, ~4MiB)
untouched — existing callers are unaffected.

SQLite's default checkpoints WAL back into the main database file every
~4MiB. That's fine for a normal read/write mix, but a large bulk load pays
increasingly expensive checkpoints as the database file grows over the
course of the load — each checkpoint has to flush WAL frames into a B-tree
that's larger, and less page-cache-resident, than the one before it. A
local repro (real `bulkInsert()` calls, 100K/500K/2M synthetic rows)
confirmed this: raising `walAutocheckpointPages` cut a 2M-row bulk load's
wall-clock time by over 50% at the largest scale tested, with the effect
growing at larger row counts. Set `walAutocheckpointPages` for a
bulk-insert-heavy workload; `0` disables automatic checkpointing entirely
for callers that would rather run one explicit `PRAGMA wal_checkpoint`
after the load finishes.
