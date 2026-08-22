---
"@nicia-ai/typegraph": patch
---

Acquire PostgreSQL schema-version and per-graph write fences in one ordered statement when a managed write needs both locks, removing one sequential round trip while preserving the portable fallback.
