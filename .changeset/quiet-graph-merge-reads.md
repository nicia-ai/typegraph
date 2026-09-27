---
"@nicia-ai/typegraph": minor
---

Read graph rows across declared kinds in keyset pages for merge planning and review, avoiding an empty query for each unused kind. Reuse one row read when the target is both sides of a diff, and skip statistics refresh for disposable ingestion clones. Custom backends continue using the existing per-kind read path.
