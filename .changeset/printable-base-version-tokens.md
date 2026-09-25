---
"@nicia-ai/typegraph": minor
---

`base@V` tokens are now printable text. Their two components were joined by a NUL character, which PostgreSQL `text` and `jsonb` columns reject, so an application could not persist a durable branch descriptor, a recorded fork point, a merge plan, or durable operation evidence in PostgreSQL without re-encoding it. The separator is now `|`.

### Upgrade notes

- Merge or discard in-flight branches, durable branches, merge plans, and review artifacts before upgrading, or re-create them afterwards. A `base@V` token minted by an earlier release is refused with `BaseVersionMismatchError` and `details.reason: "legacy-token-format"` wherever it is validated against a live store: `planMerge()`, `merge()`, `applyDurableMergePlan()`, and incremental plans from a persisted `RecordedForkPoint`. Reopening an existing durable branch still succeeds; merging it does not.
- Code that stored tokens in a re-encoded form (base64, or JSON text in a `text` column) keeps working and may store them directly.
