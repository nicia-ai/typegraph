---
"@nicia-ai/typegraph": patch
---

store: coalesce a bulk upsert that re-states a row's own validity window

`bulkUpsertById` now decides whether a requested `validFrom` / `validTo` is a
change the same way `upsertById` does, through one shared comparison, so a batch
and the same items applied one at a time write the same rows.

Two defects met in that comparison. The node bulk path refused to coalesce
whenever an item named a bound AT ALL, so any caller that re-stated a row
together with the window it already holds — a merge commit, or any
read-modify-write loop that round-trips `meta.validFrom` — bumped the row's
version and wrote a history and revision entry for a row that did not change.
The edge bulk path did compare, but compared the bounds as DRIVER TEXT: a
Postgres driver that renders `timestamptz` as a zoned string rather than a
`Date` yields text that is equivalent to the caller's canonical ISO bound
without being identical to it, so the same batch could coalesce on one backend
and write on another. Both paths now compare INSTANTS, and an unrepresentable
bound still counts as a change so the write path raises the `ValidationError`
the caller is owed rather than coalescing it away.

The bulk paths also track the window each queued write leaves behind, so a
repeated id in one batch is compared against the batch's own pending state
rather than the once-prefetched row. Previously an edge item that re-stated the
window the row held BEFORE the batch was read as unchanged and skipped, dropping
a write the sequential path performs. A later copy that re-states the window a
queued write established coalesces; one that names a bound the backend was left
to stamp (an omitted `validFrom` on a create) writes, since that instant is not
knowable batch-locally.
