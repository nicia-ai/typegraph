---
"@nicia-ai/typegraph": minor
---

Add `vector: false` to `createPostgresBackend` to disable the vector stack.

The Postgres backend wires `pgvectorStrategy` by default, assuming a standalone
Postgres server has the pgvector extension installed. An in-process Postgres
(PGlite) built without that extension can't honor it — the default strategy's
`vector(N)` DDL hard-fails the moment an embedding is written or
`CREATE EXTENSION vector` runs. Passing `vector: false` turns the stack off:
the backend advertises no `capabilities.vector` and omits the
embedding/search methods, mirroring a SQLite connection without sqlite-vec, so
the store never routes vector work to it.

Real-Postgres behavior is unchanged — the default remains `pgvectorStrategy`.
