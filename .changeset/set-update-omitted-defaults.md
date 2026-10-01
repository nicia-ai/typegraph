---
"@nicia-ai/typegraph": patch
---

Preserve omitted defaulted properties in `updateWhere()` and `compareAndSet()` patches. Validate only supplied patch and expected-state fields so defaults cannot silently overwrite stored values or run for omitted expectations.
