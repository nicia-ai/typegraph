# Temporal core (Direction F): staged plan and the TMS integration contract

*June 10, 2026. Status: ratified (same-day revision of
[tms-retraction-decision.md](./tms-retraction-decision.md)) — F-over-E
confirmed, F staged, TMS ship gate moved from "full F" to the first
as-of-recorded slice. The core commitment for each slice is conditional on
the pre-registered gates below, mirroring the discipline that adjudicated
the [E spike](./branch-visibility-spike.md).*

*Second same-day revision (June 10, evening): the **no-log line** was
ratified — TypeGraph maintains versioned state, never an event log (full
wording below). F0 (transaction-time mutation log) is dissolved; its audit
value ships as **F1a** (history capture, columns on history rows), and
as-of-recorded reads become **F1b**. Staging is now F1a → F1b → F2 → F3;
the TMS ship gate is **F1b**. Direction A dies as a named slice; Direction
D detaches into an optional merge optimization. Design:
[temporal-f1a-history-capture.md](./temporal-f1a-history-capture.md).*

---

## The no-log line (ratified June 10, 2026)

> TypeGraph maintains **versioned state, never an event log**: recorded
> time lives on rows as intervals; history is queried, not replayed. No
> stream abstraction, no offsets, no replay API — internally or publicly.
> Anything stream-shaped belongs to the host database's CDC (WAL / logical
> replication / session extension) or an upstream runtime's log (e.g.
> Electric Durable Streams).

Rationale (full version in the F1a note): F1b's read gate forces an indexed
history relation in any design, making a log additive surface; every
log-unique deliverable has a cheaper substitute (audit columns on history
rows, stamped `schema_version` instead of marker entries, timestamp anchors
or enumerate-and-compare for merge diffs, native DB CDC for outbound
streaming). The line bans the event-log *abstraction*, not tables that
record the past — history side-tables are versioned state, and without them
F1 is unimplementable as a library over vanilla SQLite/Postgres.

---

## The corrected baseline: what the tree already has

The decision doc's premise — "the model cannot yet express historical truth …
temporal invalidation only exists once F does" — is wrong as written.
Application-time temporality is shipped, public, documented API today:

- `valid_from` / `valid_to` on **both** nodes and edges
  (`src/backend/drizzle/schema/postgres.ts:95-182`, `sqlite.ts:93-180`).
- `create`/`update` accept `validFrom`/`validTo`
  (`src/store/collections/node-collection.ts:131,150`); bulk ops too.
- The query builder ships `.temporal("current" | "asOf" | "includeEnded" |
  "includeTombstones")`, compiled in the single shared path
  (`src/query/compiler/temporal.ts:51-84`), defaulting to `current`
  (`src/query/builder.ts:130`). `subgraph()` and the algorithms honor it.
- Documented at `apps/docs/src/content/docs/queries/temporal.md` ("TypeGraph
  tracks temporal validity for all nodes and edges").

What is genuinely missing — the real F program:

1. **A belief/recorded dimension distinct from domain validity.**
   `valid_from`/`valid_to` is *domain* time ("Alice worked at Acme
   2019–2023"). Retraction, invalidation, and "what did we believe at T" are
   *belief/system* time. Graphiti keeps four timestamps
   (`t_valid`/`t_invalid` vs `t_created`/`t_expired`) for exactly this
   separation.
2. **System-time guarantees.** Today's `asOf` is only as truthful as the
   caller's versioning discipline: `update` clobbers `props` in place, and
   soft-deleted rows are invisible even to `asOf`
   (`src/query/compiler/temporal.ts:71` keeps `deleted_at IS NULL`). There is
   no guaranteed "what did the graph say at T."
3. **Schema-at-T binding.** Rows do not record the schema version they were
   written under. But the timeline itself already exists:
   `typegraph_schema_versions` stores **every** version's full serialized doc
   with `created_at` (`src/backend/drizzle/schema/postgres.ts:203-225`). Only
   the row/query ↔ version binding is missing — F2 is cheaper than the
   brainstorm implied.

---

## The slices

### F1a — recorded-time history capture *(replaces F0 under the no-log line)*

History side-tables (`typegraph_node_history` / `typegraph_edge_history`)
written in the same transaction as the mutation, at the true write
chokepoint — `createCommonOperationBackend`
(`src/backend/drizzle/operation-backend-core.ts:184`), **not** the
operations layer, which `src/interchange/import.ts` bypasses. Every
mutation of an existing row captures the complete pre-image with a
`[recorded_from, recorded_to)` interval plus audit columns (`op`, `tx_id`,
`meta`, **`schema_version` stamped from day one** — the column that makes
F2 a binding problem instead of a backfill problem).

- Opt-in; off = byte-identical compiled SQL by construction. Read surface:
  typed `history(id)` per entity + `prune({ before })`. No offsets, no
  replay, no subscriptions — per the line.
- **Complete on its own** (the ship test): per-entity versioned audit
  history for any graph user — the `temporal_tables` / sqlite-history use
  case — no agent framing required.
- **Gates (final; ratified with the F1a note):** read path untouched by
  construction; single-op write latency overhead ≤ 15%; bulk-ingest
  wall-clock overhead ≤ 30%. Kill criterion: no ship, no fallback slice.
- Design, capture contract, and decisions D1–D7:
  [temporal-f1a-history-capture.md](./temporal-f1a-history-capture.md).
- *Direction D note:* branch-diff acceleration via history changed-sets
  (anchor = recorded timestamp captured inside the serializable merge
  transaction) detaches as an optional later merge optimization;
  enumerate-and-compare remains shipped behavior.

### F1b — as-of-recorded reads ← **the TMS gate**

The semantic contract, independent of implementation:

> Every row has a *currency* interval in recorded time. Ending a row's
> currency is (a) visible to as-of-recorded reads before T, (b) invisible to
> `current`-mode reads after T, (c) reversible, and (d) **never touches
> domain `valid_from`/`valid_to`**.

Note that (a) is precisely what today's soft delete cannot do — `deleted_at`
hides a row from *all* history. F1 is "a typed, reversible end-of-currency
that history can see through."

- **Implementation family: settled by F1a** *(revised under the no-log
  line — the family adjudication is no longer open)*. F1a commits the
  history-side-table substrate: current tables stay exactly as they are,
  `current`-mode reads compile to byte-identical SQL, as-of-recorded reads
  target the history relation. The E spike was the direct evidence — per-row
  visibility predicates on every scan cost ~2× on traversals
  (branch-visibility spike, Parts 2–3), and in-table row versioning
  (MariaDB-style) pays the same tax; it is dead, not "benchmarked for
  honesty."
- **F1b's remaining work is the read surface:** a recorded-time mode
  alongside the existing valid-time modes (naming TBD — see vocabulary
  guardrail below; something like `temporal("asOfRecorded", T)`, *not*
  `believedAt`), compiled in the single shared query path against
  current ∪ history.
- **Gates (proposed; final before the F1b benchmark):** `current`-mode
  overhead ≈ 0 **by construction** (asserted by compiled-SQL snapshots, not
  benchmarked); update/delete latency is F1a's gate, not F1b's;
  as-of-recorded reads ≤ 3× their `current`-mode equivalents on the E-spike
  benchmark shapes (50k nodes / 200k edges, q1–q5). **Kill criterion:** if
  the gate fails, F stops at F1a and TMS stays held as a report-only
  kernel — recorded for honesty, same as E.

### F2 — schema versions on the timeline

Bind rows and as-of reads to the schema version in force at T: history rows
carry `schema_version` (stamped from day one by F1a); as-of-recorded reads
resolve the version from the stamped column and validate rows against
the Zod schema *as of T*. This is the substrate the schema-evolution /
"did the agent break the world" thesis needs — and the only part of F with a
single dead research precedent (PRIMA, VLDB 2008). Sequenced strictly after
F1; gates TBD when its design note is written.

### F3 — Cambria-style lenses

Reading old-schema history through current types. Research-grade, unscheduled,
gates nothing. May never ship; that must stay acceptable.

---

## The F1 ↔ TMS contract (pinned now)

The held kernel (`feat/tms-retraction`, commit `5605b5e`) retargets onto
F1b through exactly two seams — both verified against the code:

- **Reads: the fixpoint is parameterized by a relation, not a table.**
  `ctx.nodesTable` / `ctx.edgesTable` plus `liveSourcePredicate` are the only
  places the kernel touches live data — *with one correction found during
  review (June 10): row currency (`deleted_at IS NULL`) was a third seam,
  inlined seven times across `fixpoint.ts`.* Fixed on the held branch (commit
  `0096afc`): the kernel now reads currency through an explicit
  `FixpointContext.currencyPredicate(alias)`, so retargeting = passing the
  as-of-recorded relation instead of the live table names + swapping one
  predicate. The "snapshot-agnostic kernel" claim is now true by
  construction, not by audit.
- **Writes: retraction is a belief transition, never a domain edit.**
  `retract()` = source flag flip + end-of-currency on each fact in
  `report.died`, all inside the existing serializable `store.transaction`
  (with the F1a history captures riding the same transaction). Un-retract =
  re-assert the source + recompute; facts regaining support open new currency
  intervals. TMS never writes `valid_from`/`valid_to` — domain time belongs
  to the user.
- **Reports stay.** `died` / `survivedVia` / `unaffected` becomes the
  *explanation* of the belief transition rather than the only output. The v1
  product mismatch ("facts die, but normal queries still return them")
  dissolves because `current`-mode queries stop returning ended facts with no
  TMS-specific predicate — and `asOfRecorded` before the retraction still
  shows what was believed.
- **Branch hygiene while held:** `feat/tms-retraction` stays unmerged and
  unpushed; rebase on a cadence (additions-only diff → cheap); do **not**
  land unexported kernel code on `main` — dead code in an OSS tree reads as
  abandonware.

---

## OSS boundary guardrails

The standing rule: TypeGraph is a legitimate general-purpose OSS project, not
a substrate shaped around one consumer. Applied here:

- **Vocabulary placement.** Core gets neutral database vocabulary
  (`recorded`, `asOf`, audit log, history). `belief`, `justification`,
  `retraction`, `Source`/`Fact` live only under the `/tms` subpath. Test: if
  a core API name only makes sense inside the agent thesis, it is in the
  wrong layer.
- **Each slice must pass a general-value test on its own.** F1a =
  per-entity versioned audit history (any CRUD app); F1b = system-time
  history queries (SQL:2011-class capability that Postgres itself lacks
  natively); F2 = typed history (the open niche since PRIMA). Agent-memory
  framing belongs in examples and guides, not in core API or schema names.
- **The no-log line** (top of this doc) is itself an OSS-shape guardrail:
  a lightweight graph library does not accrete an eventing product.
  Stream-shaped integration is the host database's CDC or an upstream
  runtime's log; TypeGraph's complementary role for log-native agent
  systems is *inbound* — materialize their streams into typed graph state,
  walk it temporally, semantically merge it.
- **Subpath over SPI, for now.** A public set-based-SQL/dialect/schema
  extension SPI with one internal consumer is how OSS projects accrete
  unmaintained platform surface. TMS keeps consuming internals through a
  single explicit `typegraph-internal.ts`-style seam file (the graph-merge
  pattern) so the *implicit* SPI stays measured and documented; revisit a
  public SPI when a real third party asks.
- **Shared derived-state substrate stays on the watch list.** TMS
  materialized belief, F1 history maintenance, and Direction H (IVM) all
  maintain derived relations as the base changes; `index_materializations` /
  `contribution_materializations` are the in-tree precedent. Don't cut F1's
  boundary so narrowly that it forecloses that substrate.

---

## Next actions

1. **F1a implementation** — design ratified
   ([temporal-f1a-history-capture.md](./temporal-f1a-history-capture.md)),
   gates final, immediately startable on `feat/temporal-f1a-history-capture`
   off `main`.
2. **F1b design note** — read algebra (current ∪ history resolution,
   tombstone interpretation), `temporal("asOfRecorded")` compilation in the
   shared query path, final gate numbers fixed before its benchmark runs.
3. **TMS branch** — rebase on `main` periodically; retarget the two contract
   seams once F1b's API sketch stabilizes; ship as the `/tms` subpath when
   F1b ships.
