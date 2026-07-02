---
"@nicia-ai/typegraph": patch
---

Stop opening a write transaction on `getOrCreateByConstraint`'s found path.
The single-item node getOrCreate wrapped its whole body — probe included — in
a transaction, so the common "already exists" case paid for `BEGIN IMMEDIATE`
on SQLite (and, under history capture, the per-graph advisory lock on
Postgres), and the nested create's operation hooks fired inside that outer
transaction, reporting success before a COMMIT that could still fail. The
probe now runs as a pure read; the create and update/resurrect legs each open
their own (hooked) transaction, so `onOperationEnd` means durably committed. A
concurrent create that reserves the key between the probe and the insert
surfaces as a uniqueness conflict and is converged by a single re-probe. The
bulk variant keeps its one enclosing transaction (atomic batch, hooks skipped
by design). Edge `getOrCreateByEndpoints` gets the same probe-first shape.
