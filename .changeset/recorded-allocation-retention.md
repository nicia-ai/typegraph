---
"@nicia-ai/typegraph": minor
---

Add `store.pruneRecordedInstants(before, { limit })` for bounded recorded allocation-log retention. Each call deletes one limited revision range and returns the deleted count, retained boundary, and whether more physical cleanup remains. A durable coverage watermark distinguishes explicitly pruned lookup coverage from unlogged history and valid naturally gapped logs. Saved anchors, allocation ownership, and captured entity history remain intact.

Upgrade storage to base-schema version 9 before enabling pruning. This release adds the nullable `anchor_retention` column to the recorded clock; bundled adapters adopt it automatically during privileged open. DML-only deployments must apply the published base-schema migration first. Custom schema providers must include the column and implement the version 9 adoption step. Upgrade every reader sharing the database before starting a retention job, and coordinate cleanup with checkpoint, replication, and entity-history retention requirements. The first batch retires lookup coverage below its boundary immediately; resume batches while `hasMore` is true to finish deleting already retired rows.
