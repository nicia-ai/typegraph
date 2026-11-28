---
"@nicia-ai/typegraph": minor
---

A call that would overlap another call's savepoint unit inside the same transaction is now refused with the new `TransactionCallRefusedError` (`TRANSACTION_CALL_REFUSED`), instead of running and possibly reporting success for a write the unit's rollback then removed.

Node and edge `bulkHardDelete` and `applyMergePlanInTransaction` run their writes behind a TypeGraph savepoint inside the caller's transaction. A savepoint's rollback undoes every statement issued on the transaction since it was taken, whichever call issued it. Before this release a call started beside one of them (under `Promise.all`, or from a hook that writes through a captured `tx`) could complete, report success, and still lose its row, its receipt count and its recorded-history row when the unit rolled back. Two units started at once could also both run, and on postgres.js poison the transaction.

TypeGraph now tracks the calls running on each transaction context and the unit one of them holds open:

- `details.reason: "savepoint-open"`: a call started while another call's unit is open is refused before it issues any statement. This includes a write an `onOperationStart` or `onError` hook starts through a captured `tx` while an adopted merge apply's unit is open.
- `details.reason: "siblings-in-flight"`: a `bulkHardDelete` or adopted merge apply started while other calls are still running on the same transaction, reads included, is refused before its first statement.

A read is a call, with no exemption: every member a transaction context offers (collection reads, query terminals, `describe()`, `validateStore()`, `batchOnce()`, `neighbors()`, `subgraph()`, identity reads, `assertUnchangedSince()`, and the read members of `tx.backend`) is refused while another call's unit is open, and runs from its call until its promise settles, so a unit cannot open beside it. A stream is a call page by page: a unit may open between two pages, and the next page is then refused while it is open. A refused call that returns a promise rejects it; `tx.backend`'s read members no longer throw a refusal synchronously.

A write runs until everything it records is recorded, including its count in the transaction receipt and in every enclosing `tx.measure()` scope, so a unit's rollback can no longer remove the count of a row written before the unit opened. `applyMergePlanInTransaction` is admitted before it validates its artifact, and throws its refusal as the `TransactionCallRefusedError` itself rather than inside a `MergeError`.

Calls are refused rather than queued: a queued call would deadlock when the unit's own callback awaits it. The writes and reads a unit's own call composes (merge apply's collection writes, collection reads and policy deletes) run as children of that call and are not refused. Calls awaited one after another are unaffected and issue exactly the statements they did before. Calls on two different transaction contexts over one native transaction are not covered yet.

`TransactionDoomedError` (`TRANSACTION_DOOMED`) is also exported from `@nicia-ai/typegraph/errors`, for a call that ran inside a transaction that is rolling back. No code path raises it in this release.

### Upgrade notes

- Inside `store.transaction()`, `withTransaction()`, `withRecordedTransaction()` and evolved transactions, await `bulkHardDelete` and `applyMergePlanInTransaction` before starting other calls on the same context, and do not start them beside calls that are still running. Code that ran them under `Promise.all` with other calls now rejects with `TransactionCallRefusedError`.
- A hook that writes through a captured transaction context while a unit is open (for example from `onOperationStart` during an adopted merge apply) is refused. Do that write after the unit's call has settled.
- A read on a transaction context, including a stream page, cannot run while another call's unit is open on that context, and `bulkHardDelete` or an adopted merge apply cannot start while a read on the same context is still running. Await reads before starting a unit, and advance a stream once the unit's call has settled.
- Code that catches the adopted merge apply's errors as `MergeError` and inspects its `cause` for `TransactionCallRefusedError` should check the thrown error itself.
