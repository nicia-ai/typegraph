---
"@nicia-ai/typegraph": minor
---

Route eligible singleton node and edge updates and soft deletes through the same exact-root atomic mutation programs as resolved bulk writes. These operations preserve per-item hooks and fallback semantics while replacing explicit managed transactions with one authoritative read or gate plus one guarded atomic mutation exchange on bundled serverless roots.

Eligible singleton updates now converge optimistically rather than holding a
write transaction across their read and write. They retry a moved preimage up
to four times before throwing `DatabaseOperationError`; under sustained
same-row contention this can refuse an update that a transaction-capable
backend previously serialized. Transaction-scoped calls and ineligible shapes
retain the interactive transaction path.
