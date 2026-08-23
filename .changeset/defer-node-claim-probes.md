---
"@nicia-ai/typegraph": patch
---

Make PostgreSQL planned node inserts authoritative for uniqueness and disjointness, folding legacy-axis and live-node checks into the write statement instead of issuing separate probe round trips.
