---
"@nicia-ai/typegraph": patch
---

Preserve PostgreSQL vector index build failures when restoring the durable `parallel_workers` setting also fails, report the exact manual cleanup, and reset TypeGraph-owned vector tables before every materialization attempt so cleanup survives backend recreation.
