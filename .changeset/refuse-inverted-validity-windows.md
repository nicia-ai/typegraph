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
- An in-place UPDATE's lone `validTo` must not precede the row's stored
  `valid_from`. Nodes already enforced this; edges did not, which is how a graph
  merge could hand a committed edge an end predating its start and still report
  success.

Interchange import records the refusal as a per-row error prefixed with
`INVERTED_VALIDITY_WINDOW`, so one bad row does not abort the import. Trusted
import refuses the whole stream with reason `invalid_stream`.

Two shapes stay legal, deliberately. A ZERO-width window
(`validTo === validFrom`) is what a same-instant retraction produces at
millisecond precision, so the store's own output still round-trips. An INSERT
carrying a lone historical `validTo` still means "born already ended": the write
instant stamped as `valid_from` is a storage convention rather than a caller
assertion, and such a row is read back through `includeEnded`.
