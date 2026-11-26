---
"@nicia-ai/typegraph": patch
---

An adopted PostgreSQL schema write (`store.withEvolvedTransaction()`, or a backend's `adoptSchemaWriteTransaction`) that runs out of its wait budget between the schema fence's acquisitions now restores the caller transaction's `lock_timeout` before it throws `SchemaFenceTimeoutError`. The fence shortens `lock_timeout` for each acquisition and restored it only on success, so when TypeGraph's own deadline check refused the write, the caller's transaction kept the shortened value (as low as `1ms`) for its remaining statements. A refusal the database raised, such as a lock timeout, aborts the transaction and still takes no restore. The documented response to `SchemaFenceTimeoutError` remains rolling back and retrying the whole transaction.
