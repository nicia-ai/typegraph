---
"@nicia-ai/typegraph": patch
---

**`importGraph()` commits the same rows at every `batchSize`.** An import used to dispose of existing rows before creates inside each `batchSize` slice but ran the slices in document order, so whether a create saw an update that freed its slot — a `oneActive` window ended earlier in the same document — depended on which slice each row landed in. The whole payload is now classified first, then every row naming an existing edge is skipped, refused or updated, then every new edge is created, then any later row repeating an id this import created is applied. `batchSize` decides round trips only. `result.errors` follows that phase order rather than document order.
