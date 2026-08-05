---
"@nicia-ai/typegraph": patch
---

identity: answer current different-ness with one probe on the separation relation

`identity.areDifferent()` and the `assertSame` contradiction precheck resolved
both identity classes and then loaded every current `different` assertion
touching one of them, scanning in JS for one that spanned the pair. That scan
grew with class size and, past the backend's bind budget, took more than one
statement. Both now probe the derived separation relation on its primary key
`(graph_id, class_key_low, class_key_high)` instead: `areDifferent` reads the
assertion ledger not at all, and the precheck reads it only to name the
conflicting assertion in the typed error it is already about to throw.

Results and typed errors are unchanged. Reads at a valid-time `asOf` or a
recorded coordinate still reconstruct from the ledger, since the separation
relation projects current assertions onto current classes. A probe never
answers "not separated" when it could not read: a missing relation refuses with
`IDENTITY_STORAGE_MISSING`, and any other driver failure propagates unchanged so
transient conflicts stay classifiable.
