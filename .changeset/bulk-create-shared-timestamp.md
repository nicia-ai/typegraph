---
"@nicia-ai/typegraph": patch
---

Document a semantic consequence of batched writes: every row a single
`bulkCreate()` / `bulkInsert()` / `importGraph()` write inserts shares one
`created_at` (and one `valid_from`), sampled once per call — not once per row,
and not once per bind-budget chunk.

Creating the same rows one at a time through `create()` gives each its own
timestamp, so `ORDER BY created_at` was a total order there and is only a
partial one after a bulk write. Prefer ordering by `id` (monotonic) or by
`(created_at, id)` when you need a stable sequence.

One instant per logical write is the intended semantics — it is what makes a
bulk write a single point in valid time rather than a smear — and it is the same
choice `valid_from` already made. Nothing changes in behavior; this note exists
because the batching work that landed this release moved several paths onto it.
