---
"@nicia-ai/typegraph": patch
---

A direct `create` on an edge kind with a durable `matchIdentity` now checks cardinality before it writes. It previously claimed the cardinality axis after the converge-create command had inserted the row, so a caller that caught the `CardinalityError` inside `store.transaction(...)` and committed kept a second live edge on a `"one"` or `"oneActive"` axis. The refusal now leaves nothing written, as it already did for batch writes and `getOrCreateByEndpoints`.
