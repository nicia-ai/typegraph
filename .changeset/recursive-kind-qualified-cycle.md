---
"@nicia-ai/typegraph": patch
---

Fix recursive traversals silently omitting nodes that share an id with a node of a different kind. Node rows are keyed by kind and id, but a recursive walk that could visit more than one kind detected cycles by id alone, so reaching a node whose id matched an earlier node of another kind on the same path was treated as a revisit: that node and everything beyond it were dropped from the results. Cycle detection now keys on kind and id whenever the walk can visit more than one kind. Single-kind walks compile to the same SQL as before, and `path` output is still an array of bare node ids.
