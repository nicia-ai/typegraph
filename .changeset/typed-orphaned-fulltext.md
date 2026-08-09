---
"@nicia-ai/typegraph": patch
---

Surface lost fulltext contribution storage on gated operations as a typed `ContributionUnavailableError` with `state: "physical-storage-missing"` and rebuild guidance. Healthy operations retain the cached marker fast path; the error path translates only a missing-relation failure whose same driver error names the declared fulltext table.
