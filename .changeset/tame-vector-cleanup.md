---
"@nicia-ai/typegraph": patch
---

Preserve PostgreSQL vector index build failures throughout serial-fallback preparation and durable `parallel_workers` cleanup, report the exact manual repair when cleanup fails, and reset built-in pgvector tables before every materialization attempt so recovery survives backend recreation without mutating custom strategy storage.
