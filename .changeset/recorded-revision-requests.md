---
"@nicia-ai/typegraph": minor
---

Add `requestRecordedRevision()` to history transaction contexts so applications can create a durable recorded-time checkpoint even when a transaction makes no entity changes. Repeated requests and entity changes in the same transaction allocate a single revision, exposed through the terminal receipt.
