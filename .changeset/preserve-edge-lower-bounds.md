---
"@nicia-ai/typegraph": patch
---

Extend `onImmutableLowerBound: "preserve"` to endpoint-matched edge writes.
`getOrCreateByEndpoints` accepts the policy in its options, and
`bulkGetOrCreateByEndpoints` accepts it per item alongside `validFrom` and
`validTo`. The policy applies a stated `validFrom` on create or resurrection,
while a live `ifExists: "update"` preserves the stored lower bound and still
applies properties and `validTo`. Strict refusal remains the default.
