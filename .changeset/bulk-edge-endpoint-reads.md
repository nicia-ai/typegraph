---
"@nicia-ai/typegraph": minor
---

Add batched multi-source edge reads: `bulkFindFrom` / `bulkFindTo`

`EdgeCollection` could only read the edges of ONE endpoint at a time, so
rendering a page of N nodes with their relationships cost N statements. The new
`store.edges.<kind>.bulkFindFrom(froms, options?)` and `bulkFindTo(tos,
options?)` read a whole SET of endpoints in one statement per endpoint kind,
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

Backend authors: `FindEdgesByKindParams` gains `fromIds` / `toIds` /
`limitPerEndpoint`. The set form is mutually exclusive with the scalar `fromId`
/ `toId`, may fan out over only one endpoint, and cannot be combined with
`limit` / `offset` / `after`; violations throw a `ConfigurationError`.
