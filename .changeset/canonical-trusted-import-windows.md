---
"@nicia-ai/typegraph": minor
---

Refuse non-canonical validity-window timestamps in trusted import.

`trustedImportGraph` / `trustedImportGraphStream` accept a pre-typed stream and
never re-parse it, so a `validFrom` / `validTo` that TypeScript types as `string`
but is not canonical fixed-width UTC ISO 8601 used to flow straight to SQL. Every
temporal filter compares those values AS TEXT against an `asOf` coordinate, so a
stored `"2021-01-01"`, `"...T00:00:00Z"`, `"...:00.1Z"` or `"...+01:00"` mis-sorts
and silently includes or excludes the wrong rows — and it mis-decided the
negative-width window check that the same path performs on the way in.

Both window fields of every streamed node and edge are now format-checked with
the same `isCanonicalIsoDate` decision the untrusted import schema and the store's
own writes make. A violation refuses the WHOLE stream with a `TrustedImportError`
carrying the existing reason `invalid_stream`, naming the offending field, row and
value; the session's transaction rolls back, so chunks already streamed are not
left behind. This is a behavior change: a stream that previously imported and
stored an unsortable timestamp now fails loudly. Convert such values with
`new Date(value).toISOString()`. The check is format-only — trusted import still
skips property, reference and conflict validation — and it leaves an absent field
and an explicitly `null` (confirmed open-left) `validFrom` untouched.

Also documents a pre-existing bulk-API limitation, with no behavior change:
`bulkUpsertById` groups every create ahead of every update, so one batch cannot
hand a constrained value from one row to another (releasing a `unique` value or a
`oneActive` edge slot and claiming it in the same batch throws `UniquenessError` /
`CardinalityError`, where the equivalent sequential upserts succeed). The
workaround is two batches, or sequential upserts.
