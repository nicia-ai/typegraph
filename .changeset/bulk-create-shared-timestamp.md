---
"@nicia-ai/typegraph": patch
---

Document a semantic consequence of batched writes: within **one backend batch
call**, every row whose timestamp TypeGraph generates shares a single instant,
sampled once for that call — not once per row, and not once per bind-budget
chunk. `bulkCreate()` and `bulkInsert()` issue one such call, so all of their
rows tie.

Creating the same rows one at a time through `create()` gives each its own
timestamp, so `ORDER BY created_at` was a total order there and is only a
partial one after a bulk write. Two things it is **not** safe to conclude:

- **`importGraph()` is not one instant.** It slices nodes and edges into
  `batchSize` batches and drives one backend call per slice, so each slice
  samples its own timestamp. Rows that carry an explicit `validFrom` in the
  import payload keep it verbatim; only generated defaults are affected.
- **Ids are not a sequence.** The default generator is a random NanoID, and
  callers may supply arbitrary ids, so `ORDER BY id` is not insertion order.
  `(created_at, id)` is a *deterministic* tiebreak, not a chronology. If input
  order matters, persist an explicit sequence column.

One instant per batch call is the intended semantics — it is what makes a bulk
write a single point in valid time rather than a smear — and it is the same
choice `valid_from` already made. Nothing changes in behavior; this note exists
because the batching work that landed this release moved several paths onto it.
