---
"@nicia-ai/typegraph": patch
---

Incremental merges now keep a node the target committed after the fork point as the survivor when a branch proposes the same entity. Two branches forked from one point that both added an entity could previously fail on the second merge: when the second branch's node had the lexicographically smaller id, it won survivor selection, and the plan tried to repoint the committed edges of the first branch's node, which `applyMergePlan()` refused as an immutable-endpoint change. Merges that resolved through `blockIndex` or a unique constraint were not affected.
