---
"@nicia-ai/typegraph": patch
---

Reuse the initial negative endpoint probe during edge get-or-create writes so no-match calls avoid a duplicate root round trip before their transaction-fenced create check.
