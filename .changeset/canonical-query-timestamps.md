---
"@nicia-ai/typegraph": patch
---

Canonicalize node and edge metadata timestamps returned by compiled queries.
All supported database drivers now expose the same fixed-width UTC ISO 8601
rendering through compiled-query projections and store collection reads.
