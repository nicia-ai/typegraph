---
"@nicia-ai/typegraph": patch
---

Make `store.transaction()` and `store.transactionWithReceipt()` fail closed on backends without transaction support instead of invoking callbacks with non-atomic write semantics.
