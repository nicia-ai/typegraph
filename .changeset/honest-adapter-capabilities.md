---
"@nicia-ai/typegraph": minor
---

Require adapter transaction callers to narrow `sqlAvailability` before reading
`tx.sql`, skip unsupported statistics maintenance on Durable Object SQLite, and
open graph-merge provenance sidecars from the target Store instead of requiring
a full backend handle.
