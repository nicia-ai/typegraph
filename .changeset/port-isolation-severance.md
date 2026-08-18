---
"@nicia-ai/typegraph": minor
---

Sever the last three Drizzle routes from the portable entrypoints. `GraphBackend` gains an optional `recordedTableDdl` member (with `RecordedTableNames` and `RecordedRelationDdl` types) so the recorded-time migration obtains its DDL from the backend rather than from Drizzle schema objects — it is called twice per migration, once per name set, and a backend without it gets a typed refusal on the migration branch rather than a crash. The claim-owner SQL comparison and the three removal builders move to portable owners with golden `{sql, params}` tests pinning byte-identical output on both dialects. A reachability scanner plus ratchet tests now assert all ten portable entrypoints are Drizzle-free at both the source and dist grain, in both module formats, so a future import cannot silently re-couple them.
