---
"@nicia-ai/typegraph": minor
---

Recognize every spelling of a one-connection Postgres cap that its driver
actually honors, so interchange refuses the pairs that would otherwise hang.
Serialized-connection detection previously required a numeric `max: 1`, which
missed three configurations that really do run every statement on one
connection:

1. `new Pool({ max: "1" })` and the legacy `new Pool({ poolSize: "1" })` — the
   shape `max: process.env.PG_MAX` produces. pg-pool never coerces the value, so
   the cap stays a string, and its own `_clients.length >= options.max` check
   then coerces it: the pool really is capped at one.
2. `postgres(url + "?max=1")` — postgres-js resolves `max` from the URL and does
   not coerce it either.
3. `PGMAX=1` with postgres-js — the same cap through the environment.

On those three backends, a streaming export/import pair now throws
`INTERCHANGE_SHARED_SERIALIZED_BACKEND_SNAPSHOT` where it previously hung, and
two concurrent streaming imports now throw
`INTERCHANGE_SERIALIZED_IMPORT_IN_PROGRESS` where they previously interleaved
and succeeded slowly — the lease is exclusive across all four pairings, so this
one conservative refusal is inherited verbatim from the existing numeric
`max: 1` behavior. `store.withWorkingCopy` and branch cloning also switch from a
streamed clone to a fully materialized in-memory export on those backends, a
memory-profile change on large graphs.

Deliberately still unmarked: a postgres-js client given a non-numeric string cap
other than one (`?max=5`), which opens exactly one connection today only because
postgres-js does not coerce it — marking that would be marking on an upstream
bug, and would refuse legitimate concurrent work the day the driver fixes it.
A `pg` pool given `max: "5"` genuinely opens five connections and is likewise
unmarked. Existing correctly-detected backends see no change: same marks, same
refusal codes, same messages.

Shipping in the same release, so nobody surprised by a new refusal is stuck:
`createSqliteBackend` and `createPostgresBackend` gain an optional
`serializedResource` declaration. `{ mode: "shared", resource: client }` marks a
connection TypeGraph cannot detect — the `?max=5` shape above, Bun `SQL`,
`expo-sqlite`, `op-sqlite`, `sqlite-proxy`, `pg-proxy` — and two backends naming
the same object are one serialized resource. `{ mode: "independent" }` escapes a
detection that is wrong for your topology. A `"shared"` declaration naming a
different object than the one detected is refused with a `ConfigurationError`
carrying `details.reason: "serialized-resource-conflict"` and a constructor-name
description of each side (`details.declaredKind` / `details.detectedKind`, never
the handles themselves — `details` is what `toLogString()` serializes, and a
driver handle there would log the credentials that driver stores) rather than
silently preferred. `"independent"` lifts the shared-resource refusal between
two distinct backends — one SQLite backend exporting into itself still reports
`INTERCHANGE_SAME_SQLITE_BACKEND_SNAPSHOT`, which is a fact about one handle
rather than a claim about connection topology. That surviving refusal is
SQLite-only, so on PostgreSQL a backend declared independent may export into
itself.
