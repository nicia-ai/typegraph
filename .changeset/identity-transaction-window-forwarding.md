---
"@nicia-ai/typegraph": patch
---

`tx.identity.assertSame(a, b, window)` and `tx.identity.assertDifferent(a, b, window)` inside `store.transaction()` now honor their validity window. The transaction surface forwarded only the two references, so a windowed assertion written in a transaction was stored as a current, open-ended one, and a malformed window was never checked. A transaction-scoped assertion with a window is now written with exactly that window, as on `store.identity`; a past-ended window therefore no longer changes current identity classes, and a malformed or future window is refused. Calls without a window are unchanged.
