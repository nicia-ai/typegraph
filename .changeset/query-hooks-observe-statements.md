---
"@nicia-ai/typegraph": patch
---

Make the documented store query hooks fire for query-builder statements,
including prepared queries, batched queries, and selective-projection retries.
Each submitted statement now reports its SQL, parameters, row count, duration,
and failures through the existing `StoreHooks` callbacks.
