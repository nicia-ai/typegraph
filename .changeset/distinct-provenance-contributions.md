---
"@nicia-ai/typegraph": patch
---

graph-merge: record each provenance contribution once, so the persisted count is
the rows actually written

Several planning phases legitimately observe the same
`(role, canonical, branch, source)` contribution. An inherited edge is credited
once when its modification survives delete/modify and again when the repoint
fold reads it as a source, and a fold set's `mergedIds` carries one entry per
staged copy — so a row staged by several branches re-offered each of its
branches once per copy. The tuple is exactly the sidecar row's identity, so
those re-observations were never new information: they inflated
`provenancePersisted.count`, and because a single `bulkUpsertById` batch cannot
create the same id twice, the over-count was the milder half: with
`persistProvenance: true`, a merge in which a single branch modified one
inherited edge failed the whole best-effort persist, so `provenancePersisted`
came back absent, a `provenance persistence failed …` warning was reported, and
NO provenance rows were written at all.

Contributions are now collapsed at the single recording funnel, so the record
list, the in-memory `provenance.byBranch` index and the reported count all
speak about distinct contributions. `persistProvenanceRecords` additionally
collapses records that hash to one id before the batch, which makes its
documented "row count written" true for any caller's record list. Every
genuinely distinct contributing branch is still credited.
