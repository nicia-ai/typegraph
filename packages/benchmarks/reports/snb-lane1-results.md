# Lane 1 (LDBC SNB Interactive short reads) — results

> **Every query-latency number below is invalidated, pending a fresh
> run.** Several rounds of review found this benchmark's query
> implementations diverged from the official LDBC queries in ways
> row-count-only parity could never catch:
>
> - **IS2 measured the wrong workload** in all three engine drivers —
>   traversing to the given person's *friends* and measuring messages
>   *they* authored, instead of official LDBC IS2's own definition ("recent
>   messages of a person": the given person's own messages, tie-broken
>   `messageId ASC`, not the `DESC` these drivers used).
> - **IS2/IS3/IS6/IS7 silently omitted official output fields** in one or
>   more engines — message content, author/moderator names, forum
>   id/title — meaning several engines were doing measurably *less work*
>   than the official query requires.
> - **Id tie-breaks were lexicographic, not numeric** (`"message:10"`
>   sorting before `"message:2"`), on every engine's native ordering. Fixed
>   at the root: `dataset/ldbc-csv.ts` zero-pads every id's numeric portion
>   to a fixed width, so a plain lexicographic `ORDER BY id ASC` (SQL or
>   Cypher alike) already agrees with numeric order.
> - **IS2's own `LIMIT` was, in turn, briefly removed entirely** to work
>   around the tie-break bug above (a same-timestamp cluster larger than
>   any fixed candidate buffer could rank a genuinely-top-10 message past
>   the cutoff) — correct, but this diverged from the official query's own
>   engine-side `ORDER BY ... LIMIT 10` (applied before the root-post-author
>   walk), changing IS2's measured workload and disproportionately
>   penalizing networked engines with full-content transfer for every
>   message a person ever authored. Once ids were zero-padded (previous
>   bullet), native `ORDER BY ... LIMIT 10` was restored everywhere — this
>   schema's split Post/Comment node types mean TypeGraph/LadybugDB fetch
>   each type's own top 10 and merge (provably equal to the true top 10 of
>   the union, for any candidate-pool or tie-cluster size), while Neo4j's
>   unified `:Message` label needs only one query.
>
> All fixed — see `typegraph-queries.ts`, `neo4j.ts`, `ladybug.ts`,
> `dataset/ldbc-csv.ts` — and the parity gate itself was upgraded from
> row-count-only to a value-level canonical digest per row
> (`engines/types.ts`'s `canonicalDigest`/`compareIdsAscending`,
> `harness/parity.ts`), specifically because row-count agreement had
> already let the IS2 workload bug and the field-omission bugs both
> through undetected. Verified end-to-end on the smoke fixture: all 7
> queries now pass **value-level** parity (`comparable=yes`) across all
> four engines, not just row-count parity.
>
> **Every IS1-IS7 latency number in this doc reflects the old, wrong
> queries** and needs a fresh SF1 + SF10 run before any of it (including
> "SQLite fastest across the board," which was only ever true at SF10,
> not SF1) can be trusted again. **Neo4j's load time is also invalidated**
> — the `Post`/`Comment` constraint removal (see "Why attempts 6-8" below)
> changes work done inside its timed `load()`, not just its query-time
> fairness. SQLite/Postgres/LadybugDB's load times are unaffected — their
> load paths weren't touched by any of this.

**Status: real SF1- and SF10-scale numbers, single run each — not a
publishable comparison yet.** Per the program plan, SF1 is the minimum
scale for any claim about relative engine performance, and this file has
had that since 2026-07-07: a full run (~9.9k persons, ~1M posts, ~2.05M
comments, official CsvBasic datagen export) completed cleanly across all
four engines with 100% row-count parity on every query. SF10 (10x scale,
~65.6k persons, ~7.4M posts, ~21.9M comments) was a stretch goal gated on
SF1 being trusted — it's now done too, and took eight EC2 attempts total
across two separate root-causing efforts: a genuine memory-exhaustion
failure that looked like a networking problem (attempts 1-5, 2026-07-11)
and, once that was fixed, an EBS volume's default IOPS ceiling that made a
correctly-implemented, locally-validated SQLite load-time fix show zero
real-world improvement (attempts 6-8, 2026-07-12) — see
[SF10 results](#sf10-results) below for both. Treat all numbers below as a
first real data point, not a final verdict — each is one run on one
machine, not the multiple runs / statistical-confidence bar a published
comparison would need. The smoke-scale table is kept below for
harness-wiring reference.

Reaching a working SF1 run required finding and fixing three real scaling
bugs (one in TypeGraph itself, two in this benchmark's own Neo4j/LadybugDB
drivers), plus a follow-up TypeGraph load-time fix found afterward — see
[Fixes made to reach a working SF1 run](#fixes-made-to-reach-a-working-sf1-run).

## SF1 environment

| | |
| --- | --- |
| Date | 2026-07-07 |
| Machine | AWS EC2 `c7i.4xlarge`, Ubuntu 24.04 LTS |
| CPU / RAM | Intel(R) Xeon(R) Platinum 8488C, 16 vCPU, 30.8 GiB |
| Node.js | v24.18.0 |
| `@nicia-ai/typegraph` | 0.34.0 |
| `better-sqlite3` | 12.11.1 |
| `pg` | 8.22.0 |
| `neo4j-driver` | 6.2.0 (server image `neo4j:2026.05.0`) |
| `@ladybugdb/core` | 0.18.0 |
| Command | `tsx src/real/snb-short-reads.ts --profile=sf1 --check` |
| Samples / warmups | 20 / 5 per query (sf1 profile defaults) |
| Runner | `pnpm bench:snb:sf1:ec2` (docs/ec2-benchmark-runner.md) — dedicated ephemeral instance, no other workload sharing the box |

Full machine-readable detail:
`bench-results/current/snb-sf1-ec2-ec2-20260707T051024Z/{summary,results}.json`
(gitignored — regenerate with `pnpm bench:snb:sf1:ec2` then the printed
`collect` command).

## SF1 load time (9,892 persons, 90,492 forums, 1,003,605 posts, 2,052,169 comments)

| Engine | Load time |
| --- | --- |
| ladybugdb | 53.8 s |
| neo4j | 306.2 s (5.1 min) |
| typegraph-postgres | 693.8 s (11.6 min) |
| typegraph-sqlite | 2,408.2 s (40.1 min) |

TypeGraph's SQLite/Postgres backends are still slower to *load* at this
scale than Neo4j or LadybugDB — both of the latter use engine-native bulk
paths (Neo4j's offline `neo4j-admin database import full`, which replaced
an earlier batched-Cypher `UNWIND ... IN TRANSACTIONS` loader; Ladybug's
`COPY FROM`), while TypeGraph's backends go through the general-purpose
`bulkInsert` API — but both improved substantially since the first SF1 run
(sqlite 74.2 min → 40.1 min, ~1.85x; postgres 80.9 min → 11.6 min, ~7x),
after fixing a real N+1 endpoint-lookup pattern in edge creation (see
[Fixes made](#fixes-made-to-reach-a-working-sf1-run)). Postgres's much
larger relative gain makes sense: eliminating a redundant round trip
matters far more over a network connection than for SQLite's in-process
calls. Further load-time work remains a follow-up (see Next steps).

## SF1 query latency (p50 / p95 / p99, milliseconds) — pre-fix numbers, superseded

**Every row below is invalidated — see the notice at the top of this
file.** Same reasons as the SF10 table below: wrong IS2 workload, missing
official fields on IS2/IS3/IS6/IS7, lexicographic id tie-breaks. Deleted
here rather than kept as "mostly still right" — a fresh SF1 run with
every fix in place (including the new value-level digest parity gate)
replaces this table and the analysis that used to follow it.

## Fixes made to reach a working SF1 run

Three independent scaling bugs blocked a working SF1 run; all three showed
the same shape (fine at smoke scale, catastrophic at SF1 scale) and were
root-caused with the same discipline — a controlled, isolated repro at
increasing scale, not guessing from the full run's symptoms.

### 1. SQLite `refreshStatistics()` O(n²) `ANALYZE` (TypeGraph core, merged)

`bulkCreate`/`bulkInsert`'s auto-refresh-statistics trigger ran a bare,
unscoped `ANALYZE` on SQLite — re-scanning every table in the database
file, unbounded, on every large batch. A 2M-row bulk load never finished
after 4.5+ hours. Fixed in `@nicia-ai/typegraph` (PR #226, merged to
`main` before this branch): scope `ANALYZE` to TypeGraph's own tables and
bound it with `PRAGMA analysis_limit`, matching Postgres's already-bounded
sampling behavior. This is a library fix, not a benchmarks-only change —
out of this PR's diff, referenced here because it's the reason a real SF1
run was possible at all.

### 2. Neo4j: `Post`/`Comment` had no per-label id index (this PR)

Neo4j's schema indexes are scoped to one label at a time and never
inherited across the other labels a multi-label node carries.
`ensureSchema()` only created uniqueness constraints on `Person`/
`Message`/`Forum`(id) — so the load's `containerOf`/`replyOf` edge-wiring
steps, which `MATCH` by id filtered on the concrete `:Post`/`:Comment`
label (not `:Message`), silently fell back to a full label scan per row.
At SF1 scale (~1M Post nodes), one 5,000-row batch turned into billions of
comparisons. Fixed by adding `snb_post_id`/`snb_comment_id` constraints;
verified via `EXPLAIN` that the query plan changed from `NodeByLabelScan`
to `NodeUniqueIndexSeek(Locking)` before trusting it at scale
(`src/real/engines/neo4j.ts`).

### 3. LadybugDB: incremental edge writes vs. its CSR storage (this PR)

LadybugDB (Kuzu-family) stores relationships in a columnar CSR
(Compressed Sparse Row) adjacency structure — cheap to build once in bulk,
expensive to update incrementally. The original loader batched edge writes
via `UNWIND ... MATCH ... CREATE` (mirroring every other engine driver's
own pattern), which a controlled repro showed scaling roughly *cubically*:
46s at 50k edges, 388s at 100k edges (~8.4x time for 2x data). Rewrote the
loader to stage each entity/edge kind to a CSV file and issue one
`COPY <table> FROM` per file (`src/real/engines/ladybug.ts`) — Ladybug's
own recommended bulk-load path. That alone dropped the same 100k-edge case
to 57ms (~6,800x), confirmed scaling linearly through 800k edges.

A second, subtler bug surfaced only at real SF1 scale: a properly
RFC4180-quoted forum title containing a comma broke Ladybug's CSV parser
specifically in a large (90k-row) file — the exact same line parsed fine
in a 2-line isolated test. The failing line's byte offset (~1.08MB) sits
suspiciously close to a 1MB buffer boundary, pointing at a parser bug when
a quoted field straddles an internal read-buffer boundary. Since LDBC's
natural-language content contains commas constantly but a literal pipe
character almost never, switching the staging delimiter from `,` to `|`
(one of Ladybug's supported delimiters) sidesteps needing to quote nearly
any real content field at all. Verified against the actual cached SF1
dataset end-to-end before trusting it on EC2.

### 4. TypeGraph's edge creation had an N+1 endpoint-existence check

TypeGraph core, merged, found after the SF1 run above already worked.

Investigating the load-time gap noted above (not a blocker like 1-3,
found afterward while chasing load performance): `bulkCreate`/`bulkInsert`
for edges validated each edge's from/to endpoint existence with a
per-edge lookup instead of batching it, unlike node creation's existing
batched-prefetch pattern. Fixed in `@nicia-ai/typegraph` (PR #227,
merged to `main` before this branch): `primeEdgeBatchValidationCache`
now collects every distinct `(kind, id)` pair across a batch's endpoints
and issues one `getNodes()` call per kind before the per-row validation
loop, mirroring node creation's `primeBatchValidationCaches`. Combined
with raising this benchmark's loader batch size (2,000 → 20,000 rows per
`bulkInsert` call), this is what dropped SQLite's load time by ~1.85x and
Postgres's by ~7x (see [SF1 load time](#sf1-load-time-9892-persons-90492-forums-1003605-posts-2052169-comments)
above).

## SF10 results

**Status: real SF10-scale numbers, single run — not a publishable
comparison yet**, same caveat as SF1 above. Getting one clean, *fast* run
took eight EC2 attempts across two root-causing efforts (below). The numbers
in this section are from attempt 8, the first run with every fix — deferred
covering index, tuned `wal_autocheckpoint`, and explicit gp3 IOPS/throughput
provisioning — actually in place together.

### SF10 environment

| | |
| --- | --- |
| Date | 2026-07-12 |
| Machine | AWS EC2 `r7i.4xlarge`, Ubuntu 24.04 LTS |
| CPU / RAM | Intel(R) Xeon(R) Platinum 8488C, 16 vCPU, 123.8 GiB |
| EBS volume | 150 GiB gp3, explicit 10,000 IOPS / 400 MB/s (see [why](#sqlites-load-time-root-cause-round-two-the-ebs-iops-ceiling)) |
| Node.js | v24.18.0 |
| `@nicia-ai/typegraph` | 0.34.0 |
| `better-sqlite3` | 12.11.1 |
| `pg` | 8.22.0 |
| `neo4j-driver` | 6.2.0 (server image `neo4j:2026.05.0`) |
| `@ladybugdb/core` | 0.18.0 |
| Command | `tsx src/real/snb-short-reads.ts --profile=sf10 --check` |
| Samples / warmups | 20 / 5 per query (sf10 profile defaults) |
| Runner | `pnpm bench:snb:sf1:ec2 -- --profile=sf10` (same script as SF1, `--profile` selects the scale) — dedicated ephemeral instance, no other workload sharing the box |
| Ref | `a58ae38ebb34ab161ab66b5c344f185988525292` |
| Total wall clock | ~5h22m (down from attempt 5's 11h10m — see below) |

Full machine-readable detail:
`bench-results/current/snb-sf10-ec2-ec2-20260712T030715Z/{summary,results}.json`
(gitignored — regenerate with `pnpm bench:snb:sf1:ec2 -- --profile=sf10`
then the printed `collect` command).

### Why attempts 1-5 took so long: memory exhaustion, not networking

The first four attempts all ran on `c7i.4xlarge` (32GB RAM) — the same
instance family SF1 used successfully — and all four died between ~3-9h in
with symptoms that looked network-related: SSM agent connectivity loss,
eventually total unreachability, no kernel panic or OOM-kill logged. That
signature was initially chased as conntrack-table exhaustion (a real,
separately-confirmed issue, fixed by raising `nf_conntrack_max` in the EC2
bootstrap script) and later as a dpkg-lock race with cloud-init's own
unattended-upgrade timers (also real, also fixed). Both fixes were
necessary but not sufficient.

Root cause, confirmed by a controlled experiment: SQLite's SF10 load phase
(loading 21.8M comment rows and building indexes over ~9h) consumes memory
proportional to available RAM, not a fixed budget. On the 32GB instance,
diagnostic monitoring (a `conntrack`/`free`/`ss` loop polled every 20s over
SSH — SSM's own agent was part of what became unreachable) caught available
memory dropping to double- then single-digit megabytes, a
`systemd-journald: Under memory pressure, flushing caches` kernel event,
and then genuine total connectivity loss as the box became too
memory-starved to fork new processes at all — not a network problem, a
resource-exhaustion problem that happened to take the network stack down
with it. Switching to `r7i.4xlarge` (128GB, same 16 vCPU) with the
identical code and dataset completed the exact same SQLite phase cleanly,
never dropping below ~40GB available. Neo4j's own offline bulk-import step
later showed the same shape at smaller scale on the 128GB box (available
memory dipped to ~7GB, then fully recovered within a minute once that step
finished) — confirming this is a load-time memory-proportional pattern
general to bulk-loading at this row count, not unique to SQLite.

Attempt 5 was clean, but slow: it landed on the same
unoptimized-checkpoint SQLite load time (8.96h) that later analysis
below root-caused and fixed. Fixing that took three more attempts.

### Why attempts 6-8 took so long: a correct, locally-validated fix that did nothing at scale

Attempt 6 caught a second, unrelated bug before it even finished: the SNB
covering index (`snb-graph.ts`'s `messageByCreationDateIndex`) was being
baked straight into the initial `CREATE TABLE` DDL instead of genuinely
deferred to after the bulk load via `store.materializeIndexes()`, despite
every engine driver's `fairness` label claiming otherwise — every insert
during the load was paying live index-maintenance cost it was supposed to
be exempt from. Killed mid-run and fixed (`a58ae38e`).

Attempt 7 combined that fix with the `wal_autocheckpoint` tuning from
[round one of SQLite's load-time root cause](#sqlites-load-time-root-cause-round-one-wal_autocheckpoint)
below, both independently validated: the covering-index fix via `EXPLAIN
QUERY PLAN`, the checkpoint fix via a local repro projecting 40-60% off
the load time. Real result: live monitoring watched it sit inside the
SQLite load phase past the 7-hour mark, on pace to land at or above the
original 8.96-hour baseline — no visible improvement. A fix that's
correct in isolation and does nothing at scale is worth taking as
seriously as an outright failure; see
[round two](#sqlites-load-time-root-cause-round-two-the-ebs-iops-ceiling)
below for why.

### SF10 load time (65,645 persons, 595,453 forums, 7,435,696 posts, 21,865,475 comments)

| Engine | Load time |
| --- | --- |
| ladybugdb | 319.8 s (5.3 min) |
| neo4j | 371.5 s (6.2 min) |
| typegraph-postgres | 6,635.7 s (1.84 h) |
| typegraph-sqlite | 11,159.3 s (3.10 h) |

Attempt 5's unoptimized numbers (SQLite 8.96h) are what motivated the two
rounds of root-causing below; this table is the outcome — SQLite's load
time falls **2.89x**, and the gap to Postgres (running the exact same
`bulkInsert` code path) narrows from ~4.85x to ~1.68x. Total wall clock
for the whole run (all four engines, all seven queries) drops from
attempt 5's 11h10m to ~5h22m. SQLite is still the slowest loader of the
four — Neo4j and LadybugDB's engine-native bulk paths remain much faster
still (see [Next steps](#next-steps)) — but the gap that looked
structural turned out to be two fixable infrastructure problems, not an
architectural ceiling. (SF1's own numbers predate both fixes, so the
earlier SF1-vs-SF10 growth-rate comparison isn't re-derived here — it
would need a fresh SF1 run under the same fixes to be a fair
like-for-like.)

#### SQLite's load-time root cause, round one: `wal_autocheckpoint`

A local, controlled repro (real TypeGraph SQLite backend, real SNB
`Comment` schema/indexes, real `bulkInsert()` calls at 100K/500K/2M
synthetic rows — not the real SF10 dataset) confirmed the slowdown isn't a
flat constant factor: per-row insert cost genuinely degrades as the table
grows.

| Scale | µs/row (cumulative) | rows/sec | 20K-row batch time spread |
| --- | --- | --- | --- |
| 100K | 18.9 | 51,525 | 300–449ms |
| 500K | 38.6 | 22,692 | 442–1,336ms |
| 2M | 99.9 | 8,270 | 838–14,459ms |

~5x throughput drop across a 20x row-count increase, with intra-phase
variance widening even faster than the average (some 20K-row batches at 2M
rows took 17x longer than others). Two candidate causes were ruled out
directly: statement-cache thrashing (only ~2 distinct SQL shapes are
generated per node kind, well under the 256-entry cache cap) and the known
SQLite/Postgres bind-parameter batch-size gap (real — SQLite's 32,766-param
cap vs. Postgres's larger effective batch — but only ~2x, not enough to
explain a 5x–13x effect on its own).

Root cause: `packages/typegraph/src/backend/sqlite/local.ts` sets WAL
journaling and `synchronous=NORMAL` but never overrides `PRAGMA
wal_autocheckpoint`, leaving it at SQLite's default of 1,000 pages (~4MB
of WAL growth between checkpoints). Every checkpoint that size has to
flush WAL frames back into a B-tree that's larger, and less
page-cache-resident, than the one before it — checkpoint cost climbs with
database size over the course of the load, and that rising cost integrates
into the super-linear total observed above. The batching/insert code
itself (`operation-backend-core.ts`, `insertNodesBatch`) is correctly
shared between the SQLite and Postgres backends and structurally sound —
this is a checkpoint-tuning gap, not a batching bug.

Fix (implemented and locally validated, `443c8d21`): raise
`wal_autocheckpoint` during bulk load and run an explicit `PRAGMA
wal_checkpoint(TRUNCATE)` right after load finishes. A follow-up repro
sweeping checkpoint intervals (0 / 250K / 500K / 1M pages, on top of the
original 1K-100K sweep) found the win holds through roughly
50,000-100,000 pages, then regresses again — an oversized WAL has its own
costs. `@nicia-ai/typegraph`'s `createLocalSqliteBackend` now exposes
`walAutocheckpointPages` (defaults to SQLite's own untouched setting);
this benchmark's SQLite driver sets it to 100,000. Verified end-to-end
against the harness (smoke profile, full load + all seven queries) — but
**this fix alone produced zero real-world improvement on the actual SF10
dataset (attempt 7)**. Round two, below, is why.

#### SQLite's load-time root cause, round two: the EBS IOPS ceiling

Root cause: `packages/benchmarks/src/real/ec2/aws-cli.ts`'s `runInstance`
provisioned its root volume as gp3 but never set an explicit `Iops` or
`Throughput` — which silently gets the account's gp3 *baseline* (3,000
IOPS / 125 MB/s) regardless of volume size. gp3, unlike gp2, decouples
IOPS/throughput from size entirely; a bigger volume buys zero extra IOPS
unless it's explicitly requested.

On a small, fresh database, checkpoint flushes batch dirty pages into
large sequential writes (~90-120 MB/s observed on real EBS — throughput-
bound, comfortably under the unprovisioned ceiling). Once the B-tree has
real size — the exact condition SF10's comments table always reaches —
the same checkpoint mechanism reverts to small, scattered, effectively
single-page (~4.2 KB average) random writes, and *those* pin against the
IOPS ceiling: `iostat -x` on real EC2/EBS infrastructure showed write
IOPS capped at *exactly* 3,000/s, independent of the `wal_autocheckpoint`
interval. Round one's checkpoint-tuning fix genuinely works — it just
could only spend its benefit while the database stayed small, and SF10's
real load never stays small for long. This is also why the round-one
local repro (100K/500K/2M synthetic rows on dev-machine NVMe) never
caught it: there's no IOPS ceiling to hit on local NVMe at this scale.
The gap only exists on real cloud block storage.

**Validated cheaply before spending another 8 hours.** Rather than commit
to another full SF10 attempt on a guess, the fix (explicit
`Iops: 10_000, Throughput: 400` on the launcher's gp3 volume — now the
default in `run-sf1-ec2.ts`, overridable via `--volume-iops`/
`--volume-throughput-mbps`) was validated on a small, short-lived,
throwaway diagnostic instance with the same volume config: a synthetic
SQLite bulk-insert workload, `iostat -x 5` running throughout.

| Phase | Checkpoint | Starting DB | Rows/sec |
| --- | --- | --- | --- |
| fresh, default | 1,000 pages | empty | 15,570 |
| fresh, tuned | 100,000 pages | empty | 22,056 |
| prepopulated, tuned | 100,000 pages | ~1.8 GB | 12,235 |
| prepopulated, default | 1,000 pages | ~1.9 GB | 9,944 |

Two things needed confirming before trusting another 8-hour run: that the
IOPS ceiling was actually gone, and that checkpoint tuning was still
worth having once it was. `iostat` confirmed the first — write IOPS
sustained 3,000-11,000+ throughout the diagnostic, never pinned at the
old hard 3,000 ceiling. The last two rows confirm the second: on the
identical prepopulated starting condition, tuned checkpointing beat
SQLite's default by 23% (245s vs. 302s) — the two fixes are
complementary, not redundant, once the ceiling masking the second one is
gone. Only then was attempt 8 launched, with the results in the tables
above and below.

### SF10 query latency (p50 / p95 / p99, milliseconds) — pre-fix numbers, superseded

**Every row below is invalidated — see the notice at the top of this
file.** IS2 measured the wrong workload (friends' messages, not the given
person's own); IS3/IS6/IS7 were missing official output fields on one or
more engines (message content, author/moderator names, forum id/title);
id tie-breaks were lexicographic instead of numeric. The old table (and
every paragraph of analysis that used to follow it) is deleted here
rather than kept as "mostly still right" — Neo4j's IS6 and TypeGraph's/
LadybugDB's IS7 in particular now do measurably *more* real work (fetching
fields they previously skipped), so even queries whose *shape* didn't
change (IS1, IS4, IS5) can't be assumed unaffected by association. A
fresh SF10 run with every fix in place — including the new value-level
digest parity gate, verified passing on the smoke fixture — replaces this
whole subsection.

The one thing worth keeping ahead of that re-run: the *structural* reason
IS2 will likely still dominate every engine's latency is unchanged by any
of these fixes — it's still a top-10 selection followed by a per-message
root-walk (batched or not), inherently more round-trip-heavy than a
single-hop point lookup like IS1/IS4/IS5. The specific numbers that
reasoning used to cite are gone; the shape of the explanation isn't.

## Query-latency experiment: concurrent per-message root walks (tried, reverted)

IS2 and IS7 each make 2+ independent, single-seed lookups per request
(IS2's per-message root-post walk; IS7's parent-author and replies
fetches). Both were rewritten to run their independent lookups
concurrently via `Promise.all` instead of sequentially, on the theory
that overlapping round-trip latency should help, especially Postgres.
Measured on this dedicated EC2 box, the effect was a wash for SQLite (as
expected — it serializes concurrent `execute()` calls internally, so
there's nothing to overlap) and a mild *regression* for Postgres (IS2:
~15-17% slower), most likely because this benchmark's Postgres runs in a
local Docker container over `localhost` TCP — there's little real
round-trip latency to hide, so promise/connection-pool scheduling only
adds overhead. Reverted; not merged.

## Smoke-scale results (harness-wiring reference only)

Kept for reference — this is what proved the harness and all four query
implementations wired correctly end-to-end before SF1 was attempted. Not
meaningful for performance comparison (load time here is dominated by
fixed setup costs like container startup, not row count).

| Engine | Load time |
| --- | --- |
| typegraph-sqlite | 28.1 ms |
| ladybugdb | 67.3 ms |
| typegraph-postgres | 185.0 ms (includes imperative container startup) |
| neo4j | 5993.2 ms (includes imperative container startup + constraint/index `awaitIndexes`) |

Row-count parity: 7/7 queries comparable=yes (31 persons, 5 forums, 40
posts, 105 comments — including a dedicated 25-comment same-creationDate
tie cluster, see "Next steps" below; 15 samples / 3 warmups per query).
Re-verified after the IS2/IS3/IS6/IS7 fixes and the row-count-to-value-level
parity upgrade above — all 7 queries pass **value-level** digest parity on
this same fixture, not just row-count parity.

## Next steps

- [x] ~~TypeGraph maintainers investigate the bulk-load scaling finding
      above.~~ Fixed and merged (PR #226).
- [x] ~~Re-run `bench:snb:sf1` once resolved; replace this doc's
      smoke-scale table with real SF1 numbers.~~ Done — see above.
- [x] ~~Investigate why TypeGraph's SQLite/Postgres backends load
      ~65-100x slower than Neo4j/LadybugDB at SF1 scale.~~ Found and
      fixed a real N+1 endpoint-lookup pattern in edge creation (PR
      #227) plus tuned this benchmark's loader batch size — cut sqlite
      load ~1.85x and postgres ~7x. Neo4j/LadybugDB's engine-native bulk
      paths remain faster still; TypeGraph's `bulkInsert` has no
      equivalent of Ladybug's `COPY FROM` or Neo4j's offline
      `neo4j-admin database import`, which is a larger, separate
      investigation if pursued further.
- [x] ~~Re-run the full SF1 EC2 benchmark to capture clean, comparable
      numbers.~~ Done — see above (also used to test and correctly
      reject the concurrent-root-walk experiment).
- [ ] Run SF1 and SF10 multiple times each and report a distribution, not a
      single sample, before making any comparative claim publicly.
- [x] ~~SF10 remains a stretch goal per the plan, gated on SF1 numbers being
      trusted (multi-run, not single-sample).~~ Done — see
      [SF10 results](#sf10-results) above. Took five EC2 attempts to
      root-cause a memory-exhaustion failure on 32GB instances; a 128GB
      instance completed cleanly.
- [x] ~~Investigate why TypeGraph's SQLite backend is ~4.85x slower than
      Postgres at SF10 despite sharing the exact same `bulkInsert` loader
      code path and running in-process (no network round trip) — and why
      that gap is worse-than-linear.~~ Root-caused in two rounds: SQLite's
      `wal_autocheckpoint` was never tuned for bulk load (round one), and
      even after fixing that, the EC2 launcher's gp3 volume was never
      provisioned above the account's default IOPS baseline, which capped
      checkpoint I/O once the database had real size (round two). See
      [round one](#sqlites-load-time-root-cause-round-one-wal_autocheckpoint)
      and [round two](#sqlites-load-time-root-cause-round-two-the-ebs-iops-ceiling)
      above.
- [x] ~~Implement and measure the proposed fix.~~ Done, in two parts: the
      `wal_autocheckpoint` tuning (round one) and explicit gp3 IOPS/
      throughput provisioning (round two) — see both sections above for
      the local repro, the diagnostic validation, and the real numbers.
- [x] ~~Re-run the full SF10 EC2 benchmark to confirm the `wal_autocheckpoint`
      fix's real-world load-time improvement and capture a second SF10
      data point (also moves toward the multi-run statistical-confidence
      bar noted above).~~ Done — attempt 8, 2026-07-12. SQLite load time:
      8.96h → 3.10h (2.89x). See [SF10 load time](#sf10-load-time-65645-persons-595453-forums-7435696-posts-21865475-comments)
      above. Still only one data point at SF10, though — the
      multi-run-distribution bar below remains open.
- [x] ~~Fix the EC2 collection tooling's SSM output-truncation bug~~ (found
      when all four engines succeeded on the same run for the first time —
      attempt 8 — and the combined size of results.json + summary.json +
      new history.jsonl lines + a console-log tail finally exceeded SSM's
      24,000-character `StandardOutputContent` cap, silently dropping
      ladybugdb's history entry). `collect()` now fetches each artifact via
      its own separate SSM command instead of one shared command's stdout.
- [x] ~~A PR review found IS2 implements the wrong workload in all three
      engine drivers (traverses to friends and measures messages they
      authored; official LDBC IS2 is the given person's own messages,
      tie-broken `messageId ASC` not the `DESC` these drivers used) — see
      the notice at the top of this file.~~ Fixed in `typegraph-queries.ts`,
      `neo4j.ts`, and `ladybug.ts`.
- [x] ~~A second review round found the round-1 IS2 fix was still
      incomplete (missing message content in TypeGraph; missing content
      *and* author names in Neo4j/LadybugDB; id tie-breaks were
      lexicographic — `"message:10"` before `"message:2"` — not numeric),
      and that IS3/IS5/IS6/IS7 weren't equivalent across engines either
      (TypeGraph's IS3 had no ordering at all; Neo4j's/LadybugDB's IS6
      omitted forum id/title; TypeGraph's/LadybugDB's IS7 omitted reply
      content and author names) — none of which row-count-only parity
      could ever have caught.~~ Fixed: every query across all three
      engines now returns exactly the official LDBC output fields,
      correctly ordered; a shared `compareIdsAscending()` helper
      (`engines/types.ts`) makes every id tie-break numeric-aware.
- [x] ~~The parity gate itself only ever compared row counts, which is
      exactly how the bugs above went undetected for as long as they
      did.~~ Upgraded to a value-level canonical digest per row
      (`SnbQueryResult.digest`, `canonicalDigest()` in `engines/types.ts`,
      `harness/parity.ts`). Verified on the smoke fixture: this
      immediately caught one more real bug (TypeGraph's IS3 digest used
      field name `personId`, Neo4j/LadybugDB used `id` — same values,
      incomparable digests) before landing at all 7 queries passing true
      value-level parity across all four engines.
- [x] ~~IS2's first fix for the lexicographic-tie-break bug (a fixed-size
      native `LIMIT` re-sorted numerically in JS) wasn't actually
      correctness-proof — a same-creationDate tie cluster larger than the
      buffer could still rank a genuinely-top-10 message past the
      cutoff.~~ Root-caused instead: `dataset/ldbc-csv.ts` now zero-pads
      every id's numeric portion to a fixed width, making native
      `ORDER BY id ASC` agree with numeric order regardless of tie-cluster
      size. This let engine-side `ORDER BY ... LIMIT 10` be restored
      everywhere (matching the official query's own semantics, applied
      before the root-post-author walk) instead of fetching every message
      a person ever authored — the intermediate "fetch everything, sort in
      JS" fix was correct but changed IS2's measured workload and
      disproportionately penalized networked engines with full-content
      transfer.
- [x] ~~The EC2 `collect()` path could still report success with fewer
      than the full four-engine set~~ — a container failing to start on
      the instance would get silently doctor-filtered out of the run
      rather than recorded as a failure, and nothing checked how many
      engines actually produced results. Fixed: `collect()` now parses
      `results.json.engines` and requires all four canonical names
      (`harness/doctor.ts`'s `SNB_ENGINE_NAMES`) to be present, and fetches
      + preserves `competitor-doctor.json` locally (success or failure) so
      an incomplete run is diagnosable without re-connecting to the
      instance.
- [x] Added `pnpm bench:snb:verify-is2-tie-break`, an adversarial
      correctness check independent of cross-engine consensus — every
      engine agreeing has already gone wrong twice in this lane (the
      friend-workload bug, the lexicographic-tie-break bug), so consensus
      alone doesn't prove correctness. The committed smoke fixture now
      includes a dedicated person (`dataset/smoke-fixture-constants.ts`)
      who authors 25 same-creationDate comments; that person's correct IS2
      answer is knowable in advance (the cluster's 10 smallest message
      ids), and the new script checks each doctor-runnable engine's actual
      result against that known answer directly.
- [x] ~~The oracle's first version didn't actually reproduce the bug it
      claimed to guard against~~ — its 25 tie-cluster ids were one
      contiguous 3-digit range (120..144), so unpadded lexicographic order
      and numeric order coincide by construction (same-length numeral
      strings always compare identically both ways); the check would pass
      whether or not the zero-padding fix was actually applied. Fixed:
      split into two blocks of different digit widths (120..129, 4-digit
      1000..1014) — unpadded order now ranks every 4-digit id ahead of
      every 3-digit one ("1000" < "120"), so an unpadded engine returns the
      wrong answer (1000..1009 instead of 120..129). Verified directly:
      temporarily reverted the padding fix, confirmed all 4 engines fail
      with exactly that wrong answer, then restored it and confirmed they
      pass again.
- [ ] **Re-run SF1 and SF10 with every fix above in place** and replace
      every invalidated number/paragraph flagged in this doc. This
      supersedes the multi-run-distribution item below in urgency —
      there's no valid single data point yet, for any query, to build a
      distribution from.
- [ ] Run SF1 and SF10 multiple times each and report a distribution, not a
      single sample, before making any comparative claim publicly. Main
      open item gating a genuinely publishable comparison once the re-run
      above lands.
- [ ] TypeGraph's `bulkInsert` has no equivalent of Neo4j's offline
      `neo4j-admin database import` or LadybugDB's `COPY FROM` — both
      engines still load 15-60x faster than TypeGraph/SQLite even after
      the fixes above. A larger, separate investigation if pursued
      further (noted since the SF1 section; still true at SF10).
- [x] ~~A PR review found `materializeIndexes()`'s best-effort result was
      discarded in both SQLite and Postgres drivers — a failed or skipped
      SNB covering index would silently produce apparently-valid timings
      without the index the fairness label promises.~~ Fixed:
      `assertMessageIndexMaterialized()` (`schema/snb-graph.ts`) checks the
      result and throws if the index wasn't created or already
      materialized; both drivers now call it.
- [x] ~~A PR review found `collect()` (`run-sf1-ec2.ts`) extracted the
      benchmark's exit code but never checked it — a failed `--check` run
      (e.g. a genuine row-count-parity mismatch) that still produced
      partial results.json collected as a successful local command with
      exit code 0.~~ Fixed: artifact collection stays best-effort and
      unconditional, but `collect()` now throws (after writing whatever
      partial artifacts exist) when the SSM status isn't `Success`, the
      exit-code marker is missing, or the exit code is nonzero.
- [x] ~~A PR review found `--profile=sf10` always defaulted to
      `c7i.4xlarge` regardless of profile — the same instance type that
      OOM'd on four separate SF10 attempts before `r7i.4xlarge` was found
      to be required.~~ Fixed: the default is now profile-aware
      (`DEFAULT_INSTANCE_TYPE_BY_PROFILE`), defaulting `sf10` to
      `r7i.4xlarge`; `--instance-type` still overrides it explicitly.
- [x] ~~A PR review found Neo4j's `snb_post_id`/`snb_comment_id`
      uniqueness constraints have no current query-time consumer (every
      IS2/IS4-IS7 by-id match goes through `:Message`, not the concrete
      label) — biasing Neo4j's measured load time against write-time cost
      with zero query-time benefit.~~ Removed; `snb_message_id` alone
      covers every current by-id lookup. (They were a real, separate
      necessity for the retired batched-Cypher load path's edge-wiring,
      which no longer exists — the offline `neo4j-admin` importer never
      issues a Cypher `MATCH`.)
- [x] ~~A second review round found a successful SSM command with no
      results could still report success (`resultsText === "{}"` wasn't
      part of `collect()`'s failure predicate).~~ Fixed: `!hasParseableResults`
      added to the failure check.
- [x] ~~Failed runs could contaminate canonical history — `reports/
      history.jsonl` was appended before the run's success was
      validated.~~ Fixed: raw history lines are always preserved locally
      (run-scoped) for post-mortem; the canonical file is only appended
      after every success condition passes.
- [x] ~~Four smoke-test history rows this session accidentally generated
      recorded a git SHA that didn't actually contain the uncommitted
      fixes producing them.~~ Reverted, not committed.
- [x] ~~Neo4j's fairness label still described the just-removed Post/
      Comment constraints, and this doc's top notice claimed Neo4j's load
      time was unaffected by the constraint-removal fix when constraint
      creation actually runs inside its timed `load()`.~~ Both fixed.
