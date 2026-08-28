---
"@nicia-ai/typegraph": minor
---

Make `store.transaction()` and `store.transactionWithReceipt()` fail closed on backends without transaction support instead of invoking callbacks with non-atomic write semantics. Applications that intentionally relied on the old D1 or Neon HTTP fallthrough must call ordinary Store write methods directly and own partial-failure recovery explicitly.
