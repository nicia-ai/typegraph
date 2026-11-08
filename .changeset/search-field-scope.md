---
"@nicia-ai/typegraph": patch
---

Clarify that fulltext search indexes all declared searchable fields on a kind as one document, whereas vector search selects an embedding field. In hybrid search the vector field selector applies only to its leg. Document why post-filtering is not field-restricted fulltext search and preserve the refusal of current-only search indexes on historical views.
