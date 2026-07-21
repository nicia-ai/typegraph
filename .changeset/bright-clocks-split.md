---
"@nicia-ai/typegraph": minor
---

Replace timestamp-only `RecordedInstant` values with versioned anchors that
encode a strict per-graph logical revision alongside a non-decreasing physical
wall-time high-water mark. Recorded relations store numeric revisions while the
public anchor remains one durable string. Upgrade timestamp-only preview tables
with `migrateLegacyRecordedTime()` and remap external checkpoints with
`migrateRecordedAnchor()`.
