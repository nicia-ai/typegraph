---
"@nicia-ai/typegraph": patch
---

Fix `bulkUpsertById` throwing on a repeated id whose row does not exist yet.

`bulkUpsertById` applies items in order, so a repeated id in one batch is
last-write-wins — but that only held for an id that already existed. The create
branch queued its create without registering the id in the batch-local pending
map, so a second copy of a **new** id queued a second create and the batch failed
with `Node already exists` / `Edge already exists` (a unique-constraint violation
on some paths). Callers feeding a batch straight from a stream or a changeset,
where a key can legitimately appear twice, hit this on first delivery of a key.

A queued create is now registered like a queued update: a later copy of the id
takes the update path over the queued create, which runs after the batch's
creates, so the final row is exactly what the equivalent sequence of `upsertById`
calls produces — the later copy's props merged over the created row, one version
bump per real write, and the created row's validity lower bound. With
`coalesceUnchangedUpserts` enabled, a value-identical second copy of a new id now
coalesces against the queued create instead of writing a second time. Nodes and
edges are both fixed; for edges, as for an id that already existed, a later
copy's `from` / `to` are ignored because an update never repoints an edge.

Two smaller consequences of routing every queued write through the same state: a
repeated id whose dirty check rejected an earlier item's props no longer reports
the wrong error, and no later copy can coalesce against a stale prefetched row
after an earlier item queued a write.
