---
"@nicia-ai/typegraph": minor
---

Fix recursive traversals silently omitting nodes that share an id with a node of a different kind. Node rows are keyed by kind and id, but a recursive walk that could visit more than one kind detected cycles by id alone, so reaching a node whose id matched an earlier node of another kind on the same path was treated as a revisit: that node and everything beyond it were dropped from the results. Cycle detection now keys on kind and id whenever the walk can visit more than one kind. Single-kind walks compile to the same SQL as before, and `path` output is still an array of bare node ids.

Fix recursive walks on SQLite mishandling node ids that contain `|`. SQLite tracks a walk's path as one `|`-delimited string, so an id like `x|y` read as two tokens: a step to node `y` was rejected as a false cycle (PostgreSQL included it), and the `path` output split `x|y` into two ids. The SQLite path seams now percent-escape `%` and `|` in every token, and path output decodes them, so cycle detection and `path` output are exact for any id. This covers `.recursive()` queries and `store.subgraph()`. The PostgreSQL path parser also now honors quoted elements when a driver returns the path array as text, so an id containing `,`, `"`, `{`, `}`, `\` or whitespace comes back whole.

### Breaking

- `defineNode()` and `defineGraph()` now reject a node kind name containing U+001F (unit separator) with a `ConfigurationError`, the same way they already reject U+001E. Recursive walks key their cycle-detection tokens as `kind + U+001F + id`, so such a kind could make two distinct nodes spell one token and drop the second as a revisit. Rename any such kind before upgrading.
