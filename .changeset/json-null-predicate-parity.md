---
"@nicia-ai/typegraph": patch
---

Fix PostgreSQL pointer-level `pathIsNull()` / `pathIsNotNull()` predicates
misclassifying two stored value shapes. The previous text-comparison form
(`#>> path = 'null'`) went three-valued on a stored JSON `null` — so
`pathIsNull()` silently failed to match those rows on PostgreSQL while
matching them on SQLite — and misread the JSON *string* `"null"` as null,
falsely matching it with `pathIsNull()` and excluding it from
`pathIsNotNull()`. Both predicates are now type-based (`jsonb_typeof`) and
never SQL NULL, converging on SQLite's (correct) semantics. Field-level
`isNull()` / `isNotNull()` predicates were already correct and are unchanged.
Behavior change on PostgreSQL for affected data: rows holding a JSON `null`
now match `pathIsNull()`, and rows holding the string `"null"` no longer do.
