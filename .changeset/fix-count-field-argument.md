---
"@nicia-ai/typegraph": patch
---

Fix `count(alias, field)` and `countDistinct(alias, field)` ignoring the field argument in SQL compilation.

Both functions always compiled to `COUNT(alias_id)` / `COUNT(DISTINCT alias_id)` regardless of the field argument, because:

1. The aggregate emitters in `standard-builders.ts` and `set-operations.ts` hardcoded `_id` for count/countDistinct instead of calling `compileFieldValue()` like sum/avg/min/max do.
2. `collectRequiredColumnsByAlias` in `standard-pass-pipeline.ts` explicitly skipped marking the field as required for count/countDistinct, so the CTE wouldn't include the `_props` column even if the emitter were fixed.

Now `count("p", "email")` correctly compiles to `COUNT(json_extract(p_props, '$."email"'))` and `countDistinct("b", "genre")` compiles to `COUNT(DISTINCT json_extract(b_props, '$."genre"'))`.
