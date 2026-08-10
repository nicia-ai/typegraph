---
"@nicia-ai/typegraph": patch
---

Preserve PostgreSQL vector index build failures when restoring the durable `parallel_workers` setting also fails, report the exact manual cleanup, and repair a pending reset before retrying an idempotent index build.
