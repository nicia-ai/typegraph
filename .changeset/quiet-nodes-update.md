---
"@nicia-ai/typegraph": minor
---

Add a cross-backend set-based node mutation primitive that applies top-level
JSON property replacements to query-selected live rows and returns every
updated after-image for history and secondary-index orchestration. Add batched,
kind-scoped uniqueness cleanup so callers can rebuild reservations safely and
prevent a hard delete from clearing same-id nodes of another kind.
