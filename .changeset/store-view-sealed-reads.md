---
"@nicia-ai/typegraph": patch
---

**A `StoreView` read refuses a temporal coordinate its caller states instead of silently answering at the pin.** `view.subgraph()`, the ten algorithm reads (on the view and on `view.algorithms`), `view.bulkFindEdgesFrom()` / `bulkFindEdgesTo()` and `view.edges.<kind>.bulkFindFrom()` / `bulkFindTo()` omit `temporalMode`, `asOf` and `recordedAsOf` from their option types, but an untyped caller could still pass them; the view spread its own coordinate over them and answered at the pin. Each read now rejects with `ConfigurationError` `STORE_VIEW_SEALED_COORDINATE` (`details.method`, `details.stated`, and the pinned coordinate), on a `"current"` view and an `asOf` view alike, matching `view.query().temporal(...)`. Read at another coordinate through the live store or a second `store.view(...)`.
