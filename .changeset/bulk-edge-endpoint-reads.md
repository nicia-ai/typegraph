---
"@nicia-ai/typegraph": minor
---

Add batched multi-source edge reads: `bulkFindFrom` / `bulkFindTo`

`EdgeCollection` could only read the edges of ONE endpoint at a time, so
rendering a page of N nodes with their relationships cost N statements. The new
`store.edges.<kind>.bulkFindFrom(froms, options?)` and `bulkFindTo(tos,
options?)` read a whole SET of endpoints in set-oriented statements per
endpoint kind and bind-budget chunk,
returning the edges grouped per input (index `i` holds the edges of input `i`,
empty array when an endpoint has none).

This widens the predicate rather than batching the calls: `from_id = ?` becomes
`from_id IN (...)`, the same prefix seek on the edge relation's system index.
Temporal semantics are identical to `findFrom` / `findTo` — same default mode,
same `temporalMode` / `asOf` options, same soft-delete filtering, same
per-endpoint ordering — and a `StoreView` exposes both methods pinned to its
coordinate. Pass `limitPerInput` to bound each endpoint's fan-out (applied in
SQL via `ROW_NUMBER()` where the backend supports window functions). Inputs
larger than the backend's bound-parameter budget are split across statements
transparently.

Backend authors: this adds a new **optional** `GraphBackend` operation,
`findEdgesByEndpointSet(params)`, with its own `FindEdgesByEndpointSetParams`.
`FindEdgesByKindParams` is unchanged.

It is a separate operation rather than optional fields on `findEdgesByKind` so
that a backend which does not implement it cannot degrade silently. Optional
params would have left an existing backend type-correct while it ignored the id
list and returned every edge of the kind — which the collection would rebucket
into a correct-looking answer at unbounded cost. Support is now detected by the
method's presence, before any read is issued, and `bulkFindFrom` / `bulkFindTo`
refuse with a typed `ConfigurationError` on a backend without it rather than
looping `findFrom` per input.

The parameter shape also makes the previously-validated illegal states
unrepresentable: one `side` instead of two id lists, no scalar `fromId` /
`toId` to disagree with a set, and no `limit` / `offset` / `after` to slice a
read the backend splits into bind-budget chunks.
