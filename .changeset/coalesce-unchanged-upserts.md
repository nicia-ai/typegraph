---
"@nicia-ai/typegraph": minor
---

Add an opt-in `coalesceUnchangedUpserts` store option for at-least-once /
replay materializers.

Idempotent event-log projectors converge live state correctly, but every
re-delivery of a byte-identical value still performed a real write:
`upsertById` on an existing id called `updateNode` unconditionally, allocating
a fresh recorded instant and a new history row. A full replay of an N-event log
therefore rewrote every row and grew recorded history by N — the recovery /
rebuild workload inflates history the most.

With `createStore(graph, backend, { coalesceUnchangedUpserts: true })`, an
`upsertById` (or `bulkUpsertById` item) whose validated props are
value-identical to the existing **live** row performs **no write at all**: no
`updateNode`, no recorded-time capture, no history row, no revision-anchor
advance, and no `update` operation hooks. It resolves with the existing node.
The dirty-check compares the storage-normalized representation (props run
through the kind's Zod schema, key-order-independent), so it answers exactly
"would the persisted value differ?".

A write still happens (never coalesced) when the row is soft-deleted (an upsert
resurrects it), when an explicit `validFrom` / `validTo` is passed, or when any
prop differs. Default off, because some consumers want an audit row per
re-delivery. Covered symmetrically for edge `bulkUpsertById` (props only —
endpoints are the edge's identity).

Receipt semantics are unchanged and need no new signal: a coalesced upsert
still counts as one write intent (`writes.total`) but captures nothing
(`recorded` stays `undefined`) — the same two-signal shape as a no-op delete,
which at-least-once consumers already handle by carrying the prior anchor
forward.
