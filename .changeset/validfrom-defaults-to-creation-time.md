---
"@nicia-ai/typegraph": patch
---

Fix: creating a node or edge without an explicit `validFrom` now stamps the
operation's own creation timestamp instead of storing SQL `NULL`.

`NULL` is interpreted by temporal filters as open-left validity ("valid
since forever"), so a record created without `validFrom` was visible at
*any* historical `asOf` instant — including ones before the record existed.
This contradicted the documented contract ("omitted `validFrom` defaults to
now") and is fixed at the insert layer for every write path: `create`,
`createFromRecord`, `upsertById`/`upsertByIdFromRecord` (create branch),
`bulkCreate`, `bulkInsert`, `bulkUpsertById`, and get-or-create, for both
nodes and edges.

`branch()`'s working-copy clone now also exports with `includeTemporal:
true`, so a fork's `validFrom`/`validTo` exactly match the base's — without
this, the clone would re-stamp any implicit `validFrom` to the fork's own
(later) creation time, narrowing the fork's valid-time window relative to
the base it was cloned from.

`exportGraph`/`importGraph` round trips still default `includeTemporal` to
`false`; without it, imported records get a fresh `validFrom` at import
time rather than the source's original value (see the Interchange docs).
