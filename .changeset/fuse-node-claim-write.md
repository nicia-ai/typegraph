---
"@nicia-ai/typegraph": patch
---

Fuse PostgreSQL node uniqueness and disjointness claims into the planned node insert, reducing constrained single-node writes by one round trip per claim while preserving portable backend fallbacks.
