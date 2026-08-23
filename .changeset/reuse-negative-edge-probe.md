---
"@nicia-ai/typegraph": patch
---

Reuse a negative endpoint match probe for edge get-or-create dispatch, avoiding a duplicate root read before the authoritative transaction check.
