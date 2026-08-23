---
"@nicia-ai/typegraph": minor
---

Replace the optional managed-create hook with a required semantic command port that carries explicit session, atomicity, authority, and result-cache policy. Under the transaction's pre-acquired canonical graph lock, PostgreSQL endpoint get-or-create now folds the authoritative match-key read, endpoint validation, and insert into one statement, returning either the created edge or the existing winner without another cache-backed read.
