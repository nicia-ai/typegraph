---
"@nicia-ai/typegraph": patch
---

`JsonSchema` (`src/schema/types.ts`, re-exported from `src/schema`) gains
named optional members for keywords the Zod projection already emits but the
type previously left to its catch-all index signature: `prefixItems`,
`minItems`, `maxItems`, `propertyNames`, `exclusiveMinimum`,
`exclusiveMaximum`, `multipleOf`, and `contentEncoding`. This is a
source-level narrowing: code that previously assigned a value of a different
type at one of these key names (relying on the index signature) now fails to
type-check against the declared member type. No runtime behavior changes —
`JsonSchema` values are read the same way at every existing call site.
