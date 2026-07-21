---
"@nicia-ai/typegraph": minor
---

Replace timestamp-only `RecordedInstant` values with versioned anchors that
encode a strict per-graph logical revision alongside a non-decreasing physical
wall-time high-water mark. Recorded relations store numeric revisions while the
public anchor remains one durable string. Upgrade timestamp-only preview tables
with `migrateLegacyRecordedTime()` and remap external checkpoints with
`migrateRecordedAnchor()`. Driver timestamps are normalized without host-local
timezone parsing, migration integrity failures are typed, and the retained
anchor map can be dropped automatically after its final graph is cleaned up.
History-enabled async store factories now reject an unmigrated recorded schema
at open, including when the legacy tables are empty.
