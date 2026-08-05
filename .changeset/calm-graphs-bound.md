---
"@nicia-ai/typegraph": minor
---

Add optional `topK` to `pageRank()` and `personalizedPageRank()`, and optional
`minComponentSize` to `weaklyConnectedComponents()`. Both bound only result
extraction: the limit and the inclusive component-size filter are applied in
extraction SQL after the existing deterministic ordering, so bounded rows never
reach the driver. Default results and ordering are unchanged, and the graph
computation itself still runs over the whole visible induced subgraph.
