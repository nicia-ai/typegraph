---
"@nicia-ai/typegraph": minor
---

Add atomic durable-branch operations. A `DurableWorkingCopyStrategy` may now expose an optional `operations` capability that commits an opaque host mutation and its immutable evidence in one host transaction, keyed by idempotency. New public orchestrators `operateDurableBranch()`, `getDurableOperation()`, `scanDurableOperations()`, `markDurableOperationDelivered()`, and `durableBranchHasUndeliveredEvidence()` wrap it, with typed `DurableOperationError` subclasses for conflicts, unsupported capabilities, malformed evidence, and the undelivered-evidence destroy fence.
