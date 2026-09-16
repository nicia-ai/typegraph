---
"@nicia-ai/typegraph": patch
---

Reduce repeated work in identity closure repair, projection and relation query execution, candidate-scoped updates, and constrained-edge imports. Reused queries now cache their compiled SQL templates while preserving fresh temporal bindings, and large identity or import batches avoid duplicate component expansion and per-key cardinality reads.
