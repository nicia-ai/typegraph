---
"@nicia-ai/typegraph": minor
---

Return a receipt from `store.withRecordedTransaction`, and add scoped write
measurement with `tx.measure`.

- **`store.withRecordedTransaction(externalTx, fn)` now returns
  `Promise<TransactionOutcome<T>>`** instead of `Promise<T>`. The adopted path
  is the only way to get exactly-once cursors and graph writes atomically on a
  history store, and it now surfaces the same receipt `transactionWithReceipt`
  does: `receipt.writes` for dropped-change detection and `receipt.recorded` as
  the per-transaction replay anchor (`undefined` for a read-only callback or a
  non-history store).

  **BREAKING:** the adopted path now returns the result under `.result`. Migrate
  by destructuring:

  ```typescript
  // Before
  const x = await store.withRecordedTransaction(externalTx, fn);
  // After
  const { result: x } = await store.withRecordedTransaction(externalTx, fn);
  ```

- **Scoped receipts — `tx.measure(fn)`.** On the receipt-enabled contexts
  (`transactionWithReceipt`, `withRecordedTransaction`), `tx.measure(fn)` runs
  `fn` and returns a `TransactionOutcome` whose receipt counts only the writes
  that resolved on `tx.nodes` / `tx.edges` while `fn` ran — so a framework can
  attribute writes to user code it invoked (e.g. a materializer measuring
  `project(tx, change)` to detect a dropped change) without its own bookkeeping
  writes contaminating the count. A write counts in a scope iff its collection
  method resolves while the scope is open; nested and overlapping measures each
  count independently; measured writes still count in the outer receipt; a
  scoped receipt's `recorded` is always `undefined`. Plain `store.transaction()`
  contexts have no `measure` (that path runs no recorder and stays
  zero-overhead). New exported types: `MeasurableTransactionContext`,
  `MeasurableHistoryTransactionContext`, `ScopedMeasure`.
