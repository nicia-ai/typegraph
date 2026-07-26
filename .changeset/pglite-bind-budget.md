---
"@nicia-ai/typegraph": patch
---

Prevent large PGlite bulk writes from silently leaving the connection unable
to return rows. PGlite backends now advertise their safe 32,767-parameter
limit, PostgreSQL batch sizes follow the active backend capability, and
over-budget statements fail before driver dispatch.
