---
"@nicia-ai/typegraph": patch
---

Harden the Operational Identity release and adjacent write paths found during its
adversarial review. Identity interchange now exports one repeatable-read snapshot,
uses target-bound keyset pagination, cancels cleanly, and refuses imports that
would stream back into the same SQLite database or serialized PGlite connection.
Graph merge uses injective composite keys, preflights provenance sidecar collisions,
and refuses merge options it cannot honor instead of ignoring them.

Edge identity checks now include kind and endpoint kind on every create, delete,
and get-or-create path, including tombstoned rows. Node and edge `bulkDelete`
remain one atomic, hookless bulk operation, so a rolled-back commit cannot emit
successful per-item hooks. PostgreSQL vector search refuses `efSearch` when the
selected index or transaction mode cannot apply it rather than silently dropping
the accepted option.
