---
"@nicia-ai/typegraph": patch
---

Fix cursor pagination and streaming across nullable sort values. Forward and backward pages now preserve rows on both sides of a NULL partition, including tied values and queries that omit the sort field from their selected result. Existing ordering defaults remain unchanged.
