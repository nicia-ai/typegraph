---
"@nicia-ai/typegraph": patch
---

Edge delete, edge hard delete, and node hard delete no longer re-read
the row inside the write transaction. The in-transaction preflight was
pure round-trip fat on these paths: nothing consumed the row, and the
writes are already concurrency-correct on their own — the tombstone
UPDATE is guarded by `deleted_at IS NULL` and the hard deletes are
id-keyed and idempotent, so a row deleted concurrently between the
outside gate and the write lock degrades to a 0-row no-op with
identical observable behavior (verified including recorded-time history
under a deliberately staled gate). One less statement per delete
(~20% of the per-op round trips on client/server engines). Node SOFT
delete keeps its preflight deliberately: its pipeline consumes the
pre-image for uniqueness-key cleanup, now documented in place.
