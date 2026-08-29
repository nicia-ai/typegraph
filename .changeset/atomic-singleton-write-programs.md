---
"@nicia-ai/typegraph": minor
---

Route eligible singleton node and edge updates and soft deletes through the same exact-root atomic mutation programs as resolved bulk writes. These operations preserve per-item hooks and fallback semantics while replacing explicit managed transactions with one authoritative read or gate plus one guarded atomic mutation exchange on bundled serverless roots.
