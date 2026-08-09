---
"@nicia-ai/typegraph": minor
---

Store no validity lower bound for a write that would otherwise be born already
ended. A write that stamps a `valid_from` the caller did not state now stores
the write instant only when doing so leaves a window some coordinate can read:
if a stated `validTo` falls at or before that instant, the row is stored with no
lower bound at all — "ended at T, start unknown" — and reads back at every `asOf`
before its end instead of at none (#407). The decision lives in the SQL builders,
so it holds for every `GraphBackend` caller, including interchange import and
trusted import, not only for the store paths.

Three consequences worth naming:

- `meta.validFrom` is `undefined` for such a row, where it used to be an instant
  no query could match.
- A resurrecting `upsertById` / `bulkUpsertById` that names a lone historical
  `validTo` on a tombstoned node **no longer refuses**: it reaches the same
  stored shape a `create` on the same id reaches. One stated window, one outcome,
  whichever entry point resets the window.
- A `validTo` in the future is unchanged — it still stamps the write instant, so
  a scheduled-end row stays invisible before it existed.

Rows already stored with an inverted window are not rewritten; they stay
invisible at every coordinate until repaired.
