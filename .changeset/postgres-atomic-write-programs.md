---
"@nicia-ai/typegraph": minor
---

Enable the registered atomic SQL and mutation-program profile on recognized interactive PostgreSQL drivers. TypeGraph now executes eligible bulk creates, bulk deletes, singleton updates/deletes, and durable edge convergence on one pinned transaction instead of falling back to the multi-step portable write plan. Neon HTTP keeps its existing native transaction-batch path, while unrecognized PostgreSQL drivers continue to fail closed to the portable implementation.
