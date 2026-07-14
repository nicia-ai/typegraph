---
"@nicia-ai/typegraph": minor
---

Make the store transaction surface tell the truth about raw SQL and history
capture.

- **New `tx.sqlAvailability` discriminant.** Every transaction context now
  carries a required `sqlAvailability: "available" | "history" |
  "revisionTracking" | "unavailable"` field. Branch on it instead of
  truthiness-testing `tx.sql`: under `history: true` / `revisionTracking: true`
  the raw handle is present-but-throwing (so `if (tx.sql)` read truthy and then
  threw), and it is `undefined` only on the non-transactional fallback. `"available"`
  means `tx.sql` is a usable raw handle; `"history"` / `"revisionTracking"` mean
  raw SQL is disabled here; `"unavailable"` means the backend has no transactions
  (`tx.sql === undefined`, no atomicity).

- **`store.withTransaction()` on a history-enabled store is now a compile error.**
  It always threw at runtime; the call site now rejects the argument with a
  message pointing at `store.withRecordedTransaction()`. The runtime guard is
  unchanged for suppressed calls.

- **Branchable recorded-capture guard codes.** The `ConfigurationError`s these
  guards throw carry a stable `details.code`
  (`RECORDED_CAPTURE_REQUIRES_CALLBACK_TRANSACTION`,
  `RECORDED_CAPTURE_RAW_SQL_DISABLED`, `REVISION_TRACKING_RAW_SQL_DISABLED`), now
  exported as `RECORDED_CAPTURE_GUARD_CODES` with a `RecordedCaptureGuardCode`
  type and an `isRecordedCaptureGuardError(error, code?)` type guard — so a
  portable caller can distinguish "history forbids raw SQL here" from "this
  backend has no transactions" without substring-matching the message.

- **Fixed `withRecordedTransaction`'s JSDoc**, which incorrectly promised
  `tx.sql`; on the adopted path you already hold the pinned connection, so write
  your own relational tables through the external transaction handle you passed
  in.
