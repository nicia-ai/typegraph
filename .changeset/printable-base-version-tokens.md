---
"@nicia-ai/typegraph": minor
---

`base@V` tokens are now printable text. Their two components were joined by a NUL character, which PostgreSQL `text` and `jsonb` columns reject, so an application could not persist a durable branch descriptor, a recorded fork point, a merge plan, or durable operation evidence in PostgreSQL without re-encoding it. The separator is now `|`.

### Upgrade notes

- Merge or re-create branches and durable branches minted by an earlier release. Their `base@V` tokens are refused with `BaseVersionMismatchError` and `details.reason: "legacy-token-format"` when `planMerge()`, `merge()`, `planMergeIncremental()`, or `mergeIncremental()` validates the branch's base, and when an incremental plan starts from a persisted `RecordedForkPoint`. Reopening a durable branch still succeeds; planning a merge from it does not.
- Existing merge plans are unaffected. Applying a plan, including through `applyDurableMergePlan()`, validates the plan's target fence (graph id, schema, and revision anchor), not the format of the tokens recorded in its anchors. A plan whose target has not moved since planning still applies after the upgrade.
- Durable operation evidence stores the coordinates the host supplied and is not compared with newly minted tokens, so existing evidence remains readable.
- Code that stored tokens in a re-encoded form (base64, or JSON text in a `text` column) keeps working and may store them directly.
