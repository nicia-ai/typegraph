---
"@nicia-ai/typegraph": minor
---

PostgreSQL table-backed working copies now isolate pgvector sidecars under each allocation's ledger-reserved physical prefix, preserve their embeddings through clone and reopen, and remove their owned tables during destroy. Allocation claims and initial table/vector provisioning commit atomically.
