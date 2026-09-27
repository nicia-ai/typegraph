---
"@nicia-ai/typegraph": minor
---

PostgreSQL table-backed working copies now isolate pgvector sidecars per allocation, preserve their embeddings through clone and reopen, and remove their owned tables during destroy.
