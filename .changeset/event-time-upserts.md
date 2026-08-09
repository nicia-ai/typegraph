---
"@nicia-ai/typegraph": patch
---

Add an explicit event-materializer policy for node upserts. Passing
`onImmutableLowerBound: "preserve"` applies `validFrom` when the upsert creates
or resurrects a row, but preserves a live row's stored lower bound while still
applying props and `validTo`. The strict `IMMUTABLE_VALIDITY_LOWER_BOUND`
refusal remains the default. The policy is available on `upsertById`,
`upsertByIdFromRecord`, and each `bulkUpsertById` item, including unchanged
coalescing replays.

Widen the optional `better-sqlite3` peer range through 13.x and exercise 13.0.3
in this repository. Correct the event-log projector guidance to update existing
endpoint-matched edges, document historical replay window requirements, and
clarify that `MergeReport.validityEnds` only reports inherited-row claims.
