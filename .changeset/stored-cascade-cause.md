---
"@nicia-ai/typegraph": minor
---

Store the cause of an identity assertion's ending instead of deriving it.

The identity assertion relation and its recorded mirror gain nullable
`ended_by_kind` / `ended_by_id` columns. A node soft-delete cascade stamps the
deleted node's `(kind, id)` onto every assertion it ends, in the same statement
that closes the row; `NULL` means the row was retracted explicitly. Graph
merge's `RetractionCause` now reads that column instead of comparing an
assertion's `valid_to` against a deleted endpoint's `deleted_at`.

This removes the derivation's same-millisecond residue: a retraction issued in
the same millisecond as the delete that followed it is now classified as
`explicit` and survives a merge whose deletion is overruled, where the
timestamp comparison could only read the tie as a cascade and drop the
branch's intent. The hard-delete residue remains by design — a hard delete
removes the assertion rows outright, so no evidence survives to read.

Archival interchange carries the cause as an optional `endedBy` on each
assertion, so an export/import round-trip preserves why an assertion ended.
Import rejects an `endedBy` on an open assertion
(`IDENTITY_IMPORT_ENDED_BY_WITHOUT_END`) or one naming a node that is not an
endpoint of the assertion (`IDENTITY_IMPORT_ENDED_BY_NOT_ENDPOINT`); a CHECK
constraint on the relation backs both rules at the database.

Operational Identity has not shipped in a release, so the relation changes
shape with no migration path.
