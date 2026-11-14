---
"@nicia-ai/typegraph": minor
---

Add `store.pruneRecordedInstants(before)` to bound recorded allocation lookup metadata while preserving graph ownership, saved checkpoints, and first-allocation evidence. Wall-clock lookups refuse pruned coverage rather than silently returning an older state. SQLite and PostgreSQL use an atomic indexed deletion without a schema migration.

Upgrade all applications that resolve wall-clock cuts against a shared database before the first prune; older versions do not recognize pruned coverage. Saved anchors still require their original allocation owner, recording namespace, and entity history.
