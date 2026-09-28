---
"@nicia-ai/typegraph": minor
---

Add an optional backend read for exact durable edge match-identity owners, including tombstones. Candidate planning uses the bounded read to seed active owners into sparse working copies and falls back to full cloning for custom backends without the capability or when a durable owner is tombstoned.
