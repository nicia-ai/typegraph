---
"@nicia-ai/typegraph": minor
---

Replace timestamp-only `RecordedInstant` values with versioned anchors that
encode a strict per-graph logical revision alongside honest physical wall time.
This intentionally breaks the initial preview schema: recreate recorded tables
and reset persisted checkpoints before upgrading.
