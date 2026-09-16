---
"@nicia-ai/typegraph": minor
---

Expose `describe()` and `validateStore()` on transaction contexts so population statistics and validation pages can run through the pinned transaction session. Callers can request repeatable-read or serializable isolation and consume all analysis work inside one callback when they need a stable data snapshot.
