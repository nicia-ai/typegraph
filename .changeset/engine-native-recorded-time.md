---
"@nicia-ai/typegraph": minor
---

`GraphBackend` gains an optional `recordedTime` member (`EngineRecordedTimeMembers`): an engine
that tracks recorded (system) time itself, rather than through TypeGraph's own capture relations
and clock. `source(table, revision)` names the table expression `"nodes"` / `"edges"` /
`"identityAssertions"` reads its recorded rows from AS OF an opaque `EngineRecordedRevision`
(`{ revision, recordedAt }`) — the engine's own temporal-table syntax, with the interval already
folded in — and `revisionNow(session)` reads `session`'s own recorded-time revision: the current
COMMITTED revision on a root backend, or the PENDING revision an open `transaction()` handle's
writes will land at once it commits (the position `TransactionReceipt.recorded` is stamped from).
`requireRecordedTime` is the typed refusal for a caller that needs it and finds it absent, in the
same style as `requireLineage`. `TransactionBackend`/`EngineProvisioning` gain the matching
optional member, threaded onto every `transaction()` handle both bundled dialects build, exactly
parallel to `lineage`. A profile that declares `recordedTime` must also declare `lineage`
(engine-native history keeps no recorded relations for TypeGraph to derive a graph-merge change
delta from); `createSqlBackend` refuses otherwise (`ENGINE_PROFILE_RECORDED_TIME_REQUIRES_LINEAGE`).
Neither bundled Drizzle profile declares `recordedTime`, so `resolveRecordedTimeOwnership` derives
`"typegraph-relations"` for both today, and every recorded-time integration suite and the parity
snapshot are unchanged — the engine-native path is proven by a PostgreSQL-family simulation
(`tests/backends/postgres/engine-native-recorded-time.test.ts`, `pglite-engine-native-recorded-time.test.ts`)
that dresses TypeGraph's own recorded relations as a temporal-table expression, labeled as a
simulation rather than a real third engine, since no bundled backend implements one.

Every recorded read — the query compiler's recorded arm, `recorded-read-service.ts`'s point reads
and scans, the historical identity readers — now goes through one `RecordedReadSource` seam
(`source(table, revision)` / `predicate(prefix, revision)` / `carriesInterval`) instead of each
spelling the recorded relation swap and the `recorded_from <= r AND r < recorded_to` interval
itself. TypeGraph's own capture binding and the external `recordedRelation({ schema })` binding
both implement it as the recorded relation plus the interval predicate (`carriesInterval: true`);
a new third binding kind, built only for a store whose backend declares `recordedTime`, implements
it as the engine's own `source` with `predicate` always `undefined` (`carriesInterval: false`) —
the engine's own expression already scopes every row to exactly one revision. Emitted SQL for both
bundled backends is unchanged: no query-compiler behavior differs for a `typegraph-relations` or
external-binding store, proven by the untouched parity snapshot and the full recorded-time
integration and property-law suites.

`RecordedInstant` widens to a two-form grammar: TypeGraph's own `r1:<16-digit revision>:<ISO
instant>`, and a new engine-native `e1:<opaque engine revision>:<ISO instant>` minted internally
from a `revisionNow` result. `recordedInstantWallTime` works on either form; `recordedInstantRevision`
and `compareRecordedInstants` are narrower — see Breaking below. Store construction derives
`recordedTimeOwnership` once
(`resolveRecordedTimeOwnership(backend)`, `"engine-native"` exactly when `backend.recordedTime` is
declared) and branches only where engine-native genuinely differs from TypeGraph-owned capture:
`history: true` builds the engine-native read binding and leaves the backend unwrapped — no
capture relations, no clock, no write-fence-gated clock allocation; `revisionTracking: true` is
refused regardless of whether `history` is also requested
(`ENGINE_NATIVE_REVISION_TRACKING_UNSUPPORTED` — there is no TypeGraph clock for it to advance, and
the engine's own revision is available only under `history: true`); an external `recordedRead`
binding is refused (`ENGINE_NATIVE_RECORDED_READ_UNSUPPORTED`); `store.recordedNow()`,
`store.revisionNow()`, and both transaction-commit sites that stamp `TransactionReceipt.recorded`
now read the engine's revision through one owner, `#engineRecordedInstant(session)`, called once
per transaction on the actual committing handle — never once per graph, and never when the
transaction wrote nothing; and `store.asOfRecorded(instant)` refuses an instant minted under the
OTHER ownership form (`RECORDED_INSTANT_OWNERSHIP_MISMATCH`) before any read compiles.
`migrateLegacyRecordedTime` refuses under engine-native ownership
(`ENGINE_NATIVE_MIGRATE_RECORDED_TIME_UNSUPPORTED`): it rewrites TypeGraph's own recorded
relations, which an engine-native backend does not have. Reconstructing identity at a recorded
coordinate — `store.identityAtCoordinate` at a past instant, and the query compiler's historical
identity traversal — is refused under engine-native ownership
(`ENGINE_NATIVE_RECORDED_IDENTITY_UNSUPPORTED`): identity history reads TypeGraph's own recorded
relations directly, which an engine-native backend does not populate. `resolveLineage` under
engine-native ownership always answers with the backend's own `lineage` (the co-required member
above), never the recorded-relations one, since there are no recorded relations to derive it from.

Public exports beside `LineageMembers`: `EngineRecordedTimeMembers`, `EngineRecordedRevision`,
`RecordedTimeSession`, `RecordedTimeBackend`, `RecordedReadSource`, `RecordedSourceTable`. `Store`
gains a readonly `recordedTimeOwnership` property, the store-level reader of the derived ownership.
Documentation: [Engine-native recorded
time](/queries/temporal#engine-native-recorded-time) covers the reader-facing contract and the
`e1:`/`r1:` rule; [Supplying `recordedTime`](/backend-authoring#supplying-recordedtime) covers what
a profile implements; the [SQLite ↔ PostgreSQL parity
matrix](/backend-setup#sqlite--postgresql-parity) and [Engine-native recorded-time
codes](/errors#engine-native-recorded-time-codes) round it out.

## Breaking

- `capabilities.recordedTimeOwnership` is removed. It was hand-declared and could fall out of sync
  with what a backend actually implemented; ownership is now derived from `backend.recordedTime`'s
  presence. Declare `EngineProvisioning.recordedTime` instead — its presence alone makes
  `resolveRecordedTimeOwnership(backend)` answer `"engine-native"`.
- `ENGINE_NATIVE_RECORDED_TIME_NOT_IMPLEMENTED` is removed. There is no replacement code: the
  interim refusal it named no longer applies to any reachable construction path now that
  engine-native construction is implemented.
- `RecordedReadBinding` widens from a two-member union
  (`ExternalRecordedReadSource | TypeGraphRecordedReadSource`) to three members, adding
  `EngineRecordedReadSource`. `RecordedReadSource` is repurposed and newly exported: it no longer
  names the binding union (that role moved to `RecordedReadBinding`) and instead names the shared
  seam shape (`source` / `predicate` / `carriesInterval`) all three binding kinds implement.
- `ExternalRecordedReadSource` (the type `recordedRelation({ schema })` returns) widens: it now
  carries the `RecordedReadSource` seam's `source` / `predicate` / `carriesInterval` members
  alongside its existing `schema` and brand, and its string discriminant is renamed from `source`
  to `kind` (`"external"`) — the `source` name was freed for the seam method. The binding is
  brand-gated and built only by `recordedRelation({ schema })`, so this affects only code that
  pattern-matched the old `source` discriminant on a value it produced.
- `TypeGraphRecordedReadSource` (the type `history: true` binds internally) gets the same two
  changes: it widens with the `RecordedReadSource` seam's members, and its string discriminant is
  renamed from `source` to `kind` (`"typegraph-capture"`). The binding is brand-gated and built
  only internally, so this affects only code that pattern-matched the old `source` discriminant.
- `RecordedInstant`'s grammar widens to admit the `e1:` form alongside `r1:`, and
  `RecordedInstantParts` becomes a discriminated union (`kind: "typegraph" | "engine"`) instead of
  a flat `{ revision: number; recordedAt: string }`. `recordedInstantRevision(instant)` now throws
  a `ValidationError` for an `e1:` anchor — there is no TypeGraph numeric revision to return; use
  `recordedInstantWallTime(instant)` for a value that works on both forms.
  `compareRecordedInstants(a, b)` now throws when the two anchors were minted by different
  ownership forms, and compares two engine-native (`e1:`) anchors by `recordedAt` only — document
  the same-millisecond tie as a caveat in your own code if you compare engine-native anchors: two
  distinct engine revisions minted within the same millisecond compare equal, unlike a
  TypeGraph-owned anchor's strict per-commit counter.
