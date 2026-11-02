---
"@nicia-ai/typegraph": patch
---

Bind the match-key convergence isolation check to the graph that acquired the write fence, so a fence acquired for another graph in the same transaction session is refused.
