---
"@nicia-ai/typegraph": patch
---

`compareAndSet()` and `updateWhere()` no longer throw an untyped Zod error on node kinds whose schema has object-level refinements. Early field checks reconstruct a partial schema from `.shape` so refinements stay on the complete after-image, the same document `update()` already validates.
