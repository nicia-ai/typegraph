---
"@nicia-ai/typegraph": patch
---

Identity mutations (`assertSame`, `assertDifferent`, `bulkAssertSame`, `bulkAssertDifferent`, `retractSameAssertion`, `retractDifferentAssertion`, on `store.identity` and `tx.identity`) now refuse an unregistered kind, a self-assertion, or a stated window bound that is not a canonical instant before they open a transaction or take the identity graph lock. Such a call fails with the same error as before, but sooner, without issuing the lock statement and without waiting behind another writer that holds the lock. When a bulk call carries more than one defect, one of these refusals is now reported ahead of a refusal judged against the operation's clock (a future or inverted window) in an earlier pair. Valid calls issue the same statements, in the same order, under the same locks.
