---
"@nicia-ai/typegraph": patch
---

Avoid the same-kind existence round trip for claim-free creates with caller-supplied node IDs on first-party SQLite and PostgreSQL backends. Conflicts use `ON CONFLICT DO NOTHING` and retain the existing duplicate and tombstone-resurrection behavior.
