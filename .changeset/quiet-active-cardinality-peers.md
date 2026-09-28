---
"@nicia-ai/typegraph": minor
---

Bound candidate merge planning and opt-in candidate-scoped review for `oneActive` graphs on bundled backends. An active-only source read excludes ended edge history while preserving the claim rule that an open edge counts even when its `validFrom` is in the future. Custom backends without the optional read continue to use complete-clone candidate planning.
