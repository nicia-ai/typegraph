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

- **Scoped receipts — `tx.measure((scoped) => ...)`.** On the receipt-enabled
  contexts (`transactionWithReceipt`, `withRecordedTransaction`), `tx.measure`
  runs its callback with a **scoped context** — a second view over the same
  transaction — and returns a `TransactionOutcome` whose receipt counts exactly
  the writes made **through that scoped context** (`scoped.nodes` /
  `scoped.edges`). So a framework can attribute writes to user code it invoked
  (e.g. a materializer measuring `project(scoped, change)` to detect a dropped
  change) while its own bookkeeping — written through the outer `tx` — stays out
  of the count. Attribution is by which context you write through, not by
  timing, which makes overlapping and concurrent measures safe by construction
  (two scopes racing under `Promise.all` never cross-count). Nesting composes;
  measured writes still count in the outer receipt; a scoped receipt's
  `recorded` is always `undefined`. Plain `store.transaction()` contexts have no
  `measure` (that path runs no recorder and stays zero-overhead). New exported
  types: `MeasurableTransactionContext`, `MeasurableHistoryTransactionContext`,
  `ScopedMeasure<Ctx>`.

- **Adopted contexts seal on return.** A transaction context retained and
  written through *after* its `withRecordedTransaction` callback resolves now
  fails loud on both paths — the history path's capture guard is checked
  *before* the live write (so a swallowed error can no longer commit an
  uncaptured row), and the non-history path seals its receipt-tracked
  collections (so a post-return write can't persist a row the already-returned
  receipt never counted).
