---
"@nicia-ai/typegraph": patch
---

Operation hooks now mean "durably committed" everywhere. `onOperationEnd`
previously fired when an operation completed, even when that operation ran
inside an enclosing transaction whose COMMIT later failed — so hook consumers
(metrics, cache invalidation, audit logs) were told a rolled-back write
succeeded. Operations inside `store.transaction` now defer their success
hooks until the transaction commits, and a failed transaction converts every
completed operation's pending success into `onError`. Edge
`getOrCreateByEndpoints` no longer wraps its write legs in an outer
transaction (each leg commits — and reports — on its own, with a
probe/create race converged by one retry), and provenance transitions route
their source-flip and per-fact hooks through the same deferred lifecycle.
Inside an adopted transaction (`withTransaction` /
`withRecordedTransaction`) the commit belongs to the caller and cannot be
observed; hooks there keep firing at operation completion, as documented.
