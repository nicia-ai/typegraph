---
"@nicia-ai/typegraph": minor
---

Add `store.nodes.<Kind>.updateWhere()` for typed, transactional set-based node
updates selected by property and independent relationship predicates. The
operation validates complete after-images and atomically maintains uniqueness,
fulltext, vector, history, and revision state on SQLite and PostgreSQL. Its
cross-backend storage primitive returns every updated after-image and provides
bind-budgeted, graph- and concrete-kind-scoped uniqueness cleanup so rebuilding
reservations cannot clear same-id nodes of another kind.
