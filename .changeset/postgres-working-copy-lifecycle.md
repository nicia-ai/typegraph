---
"@nicia-ai/typegraph": minor
---

Add a PostgreSQL table-backed working-copy manager for graphs using bundled table and tsvector storage. It owns ephemeral and durable allocation, a persistent recovery ledger, origin-attested reopen and destroy, graph-scoped SQL cloning under source locks, and bounded inventory of unsealed allocations. Inventory rows may still be active, so callers confirm ownership before explicitly aborting one. Copies have a fixed schema and refuse evolution before mutation. Custom fulltext strategies remain available through host-level database forks.
