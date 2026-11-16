---
"@nicia-ai/typegraph": patch
---

**`importGraph()` commits the same rows at every `batchSize`.** An import used to dispose of existing rows before creates inside each `batchSize` slice but ran the slices in document order, so whether a create saw an update that freed its slot — a `oneActive` window ended earlier in the same document — depended on which slice each row landed in. The whole payload is now classified first, then every row naming an existing edge is skipped, refused or updated, then every new edge is created, then any later row repeating an id this import created is applied. The same document commits the same rows at every `batchSize`. `result.errors` follows that phase order rather than document order; within the create phase each slice still reports its batched rows' refusals before those of rows written one at a time, so the order of create refusals can differ between batch sizes — match errors to rows by `kind` and `id`.

Classifying the whole payload first means `importGraph` now holds every edge row, and the stored row of each one that names an existing edge, until the edge phase ends, where it used to hold one `batchSize` slice. An update-heavy re-import needs roughly twice the edge memory it did. Use `importGraphStream` for a document too large for that; it still holds one chunk at a time.
