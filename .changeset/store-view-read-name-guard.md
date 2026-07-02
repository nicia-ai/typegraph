---
"@nicia-ai/typegraph": patch
---

Type-check the remaining StoreView read-name buckets. `CURRENT_ONLY_READ_NAMES`
and `EDGE_BATCH_READ_NAMES` were plain `as const` arrays while every sibling
bucket carried a `satisfies readonly (keyof Collection)[]` guard, so a renamed
or mistyped method in those two would have gone uncaught at compile time. All
six buckets are now checked against the live collection keys. Compile-time only.
