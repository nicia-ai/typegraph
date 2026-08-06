---
"@nicia-ai/typegraph": minor
---

Refuse a `validFrom` that a live row's update cannot store, instead of accepting
it and writing without it.

An in-place update never rewrites `valid_from`; only a resurrection does. Stating
a bound that named a different instant used to block coalescing, so the upsert
wrote — bumping the version and capturing a history row — while the bound itself
was dropped at the SQL builder and the row's window never moved. It now raises a
`ValidationError` whose issue carries the new exported code
`IMMUTABLE_VALIDITY_LOWER_BOUND`, naming both the stated instant and the one the
row holds so the caller can restate it without a second read.

This reaches every path that accepts `validFrom` against a live row: `upsertById`
and `bulkUpsertById` (nodes and edges, including a repeated id in one batch, which
is judged against the row the batch just queued), `getOrCreateByEndpoints` and
`bulkGetOrCreateByEndpoints` with `ifExists: "update"` — which previously dropped
the option before it reached any guard — and interchange import's
`onConflict: "update"` legs, where it is recorded as a per-row error prefixed with
the code rather than aborting the import.

What stays legal: restating the bound a row already holds (nothing to apply, so
nothing is ignored); a create or a resurrection, both of which store a stated
bound and are the way to give a row a different one; zero-width windows; and
`getOrCreateByEndpoints` returning an existing edge, which performs no write at
all.

Previously-accepted writes now refuse, so this is a MINOR bump — the same
precedent as the window refusals in the two releases before it.

Note for temporal imports: replaying an `includeTemporal: true` export over rows
that were created separately now reports those rows instead of updating their
props under a lower bound it ignored. Omit `validFrom` from the update document,
export with `includeTemporal: false`, or import into a fresh graph.
