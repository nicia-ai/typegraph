---
"@nicia-ai/typegraph": patch
---

Avoid repeated selective-projection fallback queries. Smart-select planning now
covers common high-value threshold branches, and prepared queries remember a
missing-field fallback so later executions fetch the full row directly.
