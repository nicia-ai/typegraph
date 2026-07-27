---
"@nicia-ai/typegraph": minor
---

Allow idempotent endpoint-based edge writes to set application-time validity.
`getOrCreateByEndpoints` now accepts `validFrom` and `validTo`, while
`bulkGetOrCreateByEndpoints` accepts them per item. Creation applies both
fields, updates and resurrections apply `validTo`, and pure found results leave
the existing window unchanged.
