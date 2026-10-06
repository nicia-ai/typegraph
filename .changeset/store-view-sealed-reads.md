---
"@nicia-ai/typegraph": patch
---

**A `StoreView` read refuses a temporal coordinate its caller states instead of silently answering at the pin.** `view.subgraph()`, the ten algorithm reads (on the view and on `view.algorithms`), `view.bulkFindEdgesFrom()` / `bulkFindEdgesTo()`, `view.edges.<kind>.bulkFindFrom()` / `bulkFindTo()` and the point reads (`getById`, `getByIds`, `find`, `count`, and on edges `findFrom`, `findTo`, `findByEndpoints`) omit `temporalMode`, `asOf` and `recordedAsOf` from their option types, but an untyped caller could still pass them, in the position the live collection takes its own temporal options; the view answered at the pin and dropped the stated value. Each read now rejects with `ConfigurationError` `STORE_VIEW_SEALED_COORDINATE` (`details.method`, `details.stated`, and the pinned coordinate), on a `"current"` view and an `asOf` view alike, matching `view.query().temporal(...)`. Read at another coordinate through the live store or a second `store.view(...)`.

### Breaking

- A `StoreView` read that states `temporalMode`, `asOf` or `recordedAsOf` from untyped code rejects with `ConfigurationError` `STORE_VIEW_SEALED_COORDINATE`, where it previously answered at the pin and dropped the stated value. Remove the stated coordinate, or read it through the live store or a second `store.view(...)`.
