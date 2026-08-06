---
"@nicia-ai/typegraph": minor
---

Refuse valid-time windows of negative width. A write whose `validTo` precedes
the row's effective `validFrom` describes a row that stopped being true before
it started — observable at no `asOf` coordinate, and unrepairable by any later
write — and it used to be accepted silently on every path except a node update.
It now raises a `ValidationError` whose issue carries the new exported code
`INVERTED_VALIDITY_WINDOW`.

This is a behavior change: writes that previously succeeded now fail. Two shapes
refuse where they did not before.

- A stated `validFrom` / `validTo` PAIR must be ordered, on node and edge
  `create`, `upsertById`, `bulkUpsertById`, `getOrCreateByEndpoints` and its bulk
  form, and on an imported document. `getOrCreateByEndpoints` judges the pair
  before its existence probe, so whether a call is valid no longer depends on
  whether the edge happens to exist yet.
- An UPDATE's lone `validTo` must not precede the lower bound the row carries.
  Nodes already enforced this; edges did not, which is how a graph merge could
  hand a committed edge an end predating its start and still report success. This
  covers a resurrecting write too: an edge RETAINS its `valid_from` across
  resurrection, so reviving one into a window that closed before it began now
  means restating the start — pass `validFrom` alongside `validTo`. Landing a
  revived edge in the ENDED state is otherwise unchanged.

`getOrCreateByEndpoints` and its bulk form now honor `validFrom` on the
`"resurrected"` branch, where they previously accepted it and silently dropped
it — which is what left the refusal above with no way to satisfy it. As the
backend has always documented for a resurrecting write, naming `validFrom`
asserts the COMPLETE window, so an accompanying `validTo` is applied and an
omitted one REOPENS the revived row rather than leaving the tombstoned
incarnation's end in place. A `"found"` or `"updated"` live edge is unaffected:
its stored lower bound is history and still stays put.

Interchange import records the refusal as a per-row error prefixed with
`INVERTED_VALIDITY_WINDOW`, so one bad row does not abort the import; its
`onConflict: "update"` legs are held to the existing row's `valid_from` exactly
as a direct `update` is. Trusted import refuses the whole stream with reason
`invalid_stream`.

Two shapes stay legal, deliberately. A ZERO-width window
(`validTo === validFrom`) is what a same-instant retraction produces at
millisecond precision, so the store's own output still round-trips. An INSERT
carrying a lone historical `validTo` still means "born already ended": the write
instant stamped as `valid_from` is a storage convention rather than a caller
assertion, and such a row is read back through `includeEnded`.
