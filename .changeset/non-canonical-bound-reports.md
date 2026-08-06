---
"@nicia-ai/typegraph": minor
---

Report a non-canonical validity bound whether or not `coalesceUnchangedUpserts`
is on.

A parseable-but-non-canonical bound equal to the stored instant —
`"2100-06-01T00:00:00Z"` against a stored `"2100-06-01T00:00:00.000Z"` — compared
as "unchanged" with coalescing on, so the write was skipped and the
`ValidationError` the same call raises with coalescing off was swallowed. An
unrelated performance flag decided whether malformed input was reported.

A non-canonical REQUESTED bound now counts as a window change, so it reaches the
write path and raises identically either way. Re-stating a window in canonical
form still coalesces, including against a driver that renders the stored value as
an equivalent zoned string: only the stored side needs canonicalizing, because
the requested side is held to canonical form by the write validation this no
longer hides.
