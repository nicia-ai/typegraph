---
"@nicia-ai/typegraph": patch
---

Harden two failures at the operations/backend boundary: a create the engine
refuses now reports the condition it actually hit, and the last UPDATE path that
could store an inverted valid-time window no longer can.

**A create refused by the engine reports "already exists", not a raw driver
error.** A create learns an id is taken either from its own existence probe or
from the engine refusing the INSERT, and the second used to escape as a
`DrizzleQueryError` whose `.message` is the raw INSERT text. One condition
therefore surfaced as a typed user error down one path and an opaque system error
down the other, and callers could not branch on it at all. The engine's report is
now classified structurally and both routes raise the same `ValidationError`, on
the single and batch create paths for nodes and edges alike.

Two things reach the engine's path. A NODE create probes first, but the probe and
the INSERT are two statements and PostgreSQL's default READ COMMITTED does not
serialize the two write transactions, so a concurrent create of the same new id
can commit in between — the issue's reproduction. An EDGE create has no existence
probe at all, so the engine's refusal is its only report of a taken id, on every
backend and with no race involved.

Classification is structural, never message text: SQLSTATE 23505 plus the
PostgreSQL protocol's own constraint and relation fields, and SQLite's extended
result code, which distinguishes a primary-key duplicate (1555) from any other
unique-index duplicate (2067) in the code itself.

Every such refusal, from either route, now carries the new exported issue code
`ENTITY_ALREADY_EXISTS`, so a caller can recognize it without matching on the
message. `details.entityType` and `details.kind` say what was refused;
`details.id` names the taken id, and is absent only when the refused statement
inserted more than one row, because the engine reports that the statement
collided without saying which row did. No race is needed to reach that: a bulk
create of edges, whose ids the caller supplied and which nothing probes, is
refused this way on every backend.

The classification is scoped to the primary key on purpose. A `unique: true`
index declaration materializes a UNIQUE INDEX on the same relation, and violating
that is a declared-uniqueness failure about the row's VALUES rather than a
duplicate identity — PostgreSQL reports it under the index's own name and SQLite
under a different extended code, so it never matches and is unaffected. Neither is
a declared `unique` constraint conflict, which still raises `UniquenessError`.

SQLite never reached the node race: `BEGIN IMMEDIATE` gives the writer slot to
one transaction at a time, so a second create cannot sit between its probe and its
INSERT while the first commits. Its probe is authoritative there, and the refusal
was already the typed error — it now carries the code too. A duplicate EDGE id on
SQLite did surface as a raw `SqliteError`, and now raises the same error as it
does on PostgreSQL.

**A node resurrection stores the bound its window guard measured against.** A
resurrection rewrites `valid_from` rather than retaining it, so the guard that
refuses inverted windows has no stored bound to check and used the write instant
instead — sampled in the operations layer, while the backend went on to stamp its
own, strictly later, sample. A `validTo` at the guard's instant passed as
zero-width and committed as NEGATIVE width a millisecond later, the exact shape
the previous release exists to refuse. The operations layer now passes the
instant it validated against explicitly, so the bound that is checked is the
bound that is stored. Stating both endpoints is unaffected; the only change to a
successful write is that a resurrection's `valid_from` is the operations layer's
instant rather than the backend's — sampled a moment earlier inside the same
locked write, before the uniqueness entries it re-checks and re-inserts.

Edge resurrection was never exposed: an edge RETAINS its stored `valid_from`
unless the write names a new one, so its guard measures against a value already
on disk and predicts nothing.
