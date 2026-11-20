---
"@nicia-ai/typegraph": patch
---

A node write now refreshes its embedding and fulltext sidecars one after the other, embeddings first, instead of starting both at once. Inside a transaction the single connection already ran them one at a time, so nothing gets slower, but the order in which the two reached the database varied with cache state, and so did which sidecar error a failing write reported. Statement logs and recorded captures of node creates, updates, resurrections and bulk creates are now reproducible.
