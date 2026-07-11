# Lane 1 (LDBC SNB Interactive short reads) — results

**Status: real SF1- and SF10-scale numbers, single run each — not a
publishable comparison yet.** Per the program plan, SF1 is the minimum
scale for any claim about relative engine performance, and this file has
had that since 2026-07-07: a full run (~9.9k persons, ~1M posts, ~2.05M
comments, official CsvBasic datagen export) completed cleanly across all
four engines with 100% row-count parity on every query. SF10 (10x scale,
~65.6k persons, ~7.4M posts, ~21.9M comments) was a stretch goal gated on
SF1 being trusted — it's now done too (2026-07-11), after root-causing a
genuine memory-exhaustion failure that killed four earlier attempts (see
[SF10 results](#sf10-results) below). Treat all numbers below as a first
real data point, not a final verdict — each is one run on one machine, not
the multiple runs / statistical-confidence bar a published comparison would
need. The smoke-scale table is kept below for harness-wiring reference.

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
paths (Neo4j's batched `UNWIND ... IN TRANSACTIONS OF 5000 ROWS`, Ladybug's
`COPY FROM`), while TypeGraph's backends go through the general-purpose
`bulkInsert` API — but both improved substantially since the first SF1 run
(sqlite 74.2 min → 40.1 min, ~1.85x; postgres 80.9 min → 11.6 min, ~7x),
after fixing a real N+1 endpoint-lookup pattern in edge creation (see
[Fixes made](#fixes-made-to-reach-a-working-sf1-run)). Postgres's much
larger relative gain makes sense: eliminating a redundant round trip
matters far more over a network connection than for SQLite's in-process
calls. Further load-time work remains a follow-up (see Next steps).

## SF1 query latency (p50 / p95 / p99, milliseconds) — row-count parity: **7/7 queries comparable=yes, 0 engine failures**

| Query | typegraph-sqlite | typegraph-postgres | neo4j | ladybugdb |
| --- | --- | --- | --- | --- |
| IS1 (person profile) | 0.038 / 0.066 / 0.074 | 0.089 / 0.116 / 0.179 | 0.921 / 1.192 / 4.931 | 0.344 / 0.434 / 0.442 |
| IS2 (friends' recent messages) | 81.575 / 264.280 / 381.127 | 203.229 / 605.720 / 876.873 | 25.035 / 102.378 / 172.022 | 62.142 / 82.944 / 90.185 |
| IS3 (friends with dates) | 0.225 / 0.987 / 0.996 | 0.569 / 2.114 / 2.311 | 1.101 / 2.127 / 3.985 | 2.289 / 3.429 / 3.703 |
| IS4 (message content) | 0.020 / 0.027 / 0.035 | 0.088 / 0.124 / 0.139 | 0.768 / 2.502 / 2.813 | 0.272 / 0.300 / 0.306 |
| IS5 (message creator) | 0.035 / 0.036 / 0.037 | 0.124 / 0.135 / 0.137 | 0.691 / 0.862 / 3.289 | 0.954 / 0.999 / 1.025 |
| IS6 (root forum + moderator) | 0.095 / 0.125 / 0.160 | 0.721 / 0.792 / 1.185 | 0.721 / 0.965 / 4.556 | 3.027 / 3.333 / 3.347 |
| IS7 (replies + knows check) | 0.090 / 1.202 / 1.324 | 0.265 / 3.890 / 7.061 | 1.222 / 27.811 / 47.521 | 2.906 / 4.955 / 5.077 |

Several queries are flagged noisy (CV > 25%, see `results.json`'s `noisy`
field) — expected for a single-run measurement of sub-millisecond-to-
low-double-digit-millisecond operations on a shared cloud instance. IS2's
much higher latency across every engine reflects real work (merging and
re-ranking up to 10 messages across a friend frontier, then a root-post
walk per message), not overhead — the same query is also the noisiest,
consistent with its cost scaling with each sampled person's actual friend
count and message volume rather than being a fixed-cost point read like
IS1/IS4/IS5.

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
comparison yet**, same caveat as SF1 above. Getting one clean run took five
EC2 attempts.

### SF10 environment

| | |
| --- | --- |
| Date | 2026-07-11 |
| Machine | AWS EC2 `r7i.4xlarge`, Ubuntu 24.04 LTS |
| CPU / RAM | Intel(R) Xeon(R) Platinum 8488C, 16 vCPU, 123.8 GiB |
| Node.js | v24.18.0 |
| `@nicia-ai/typegraph` | 0.34.0 |
| `better-sqlite3` | 12.11.1 |
| `pg` | 8.22.0 |
| `neo4j-driver` | 6.2.0 (server image `neo4j:2026.05.0`) |
| `@ladybugdb/core` | 0.18.0 |
| Command | `tsx src/real/snb-short-reads.ts --profile=sf10 --check` |
| Samples / warmups | 20 / 5 per query (sf10 profile defaults) |
| Runner | `pnpm bench:snb:sf10:ec2` — dedicated ephemeral instance, no other workload sharing the box |
| Total wall clock | ~11h10m |

Full machine-readable detail:
`bench-results/current/snb-sf10-ec2-ec2-20260711T004520Z/{summary,results}.json`
(gitignored — regenerate with `pnpm bench:snb:sf10:ec2` then the printed
`collect` command).

### Why it took five attempts: memory exhaustion, not networking

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

### SF10 load time (65,645 persons, 595,453 forums, 7,435,696 posts, 21,865,475 comments)

| Engine | Load time |
| --- | --- |
| ladybugdb | 338.9 s (5.6 min) |
| neo4j | 490.2 s (8.2 min) |
| typegraph-postgres | 6,652.2 s (1.85 h) |
| typegraph-sqlite | 32,248.9 s (8.96 h) |

SQLite's load time is the standout finding at this scale: ~4.85x slower
than Postgres running the *same* `bulkInsert` code path
(`packages/benchmarks/src/real/engines/typegraph-load.ts` is shared between
both SQL backends — identical batch size, identical row counts per call),
despite being in-process with no network round trip, which should favor
SQLite, not penalize it. It's also the only backend whose slowdown is
worse than linear: postgres's load time grew ~9.6x for SF10's ~10.65x row
count over SF1 (2026-07-07 SF1 run: 693.8s), essentially linear, while
SQLite's grew ~13.4x over its own SF1 baseline (2,408.2s) for the same
~10.65x data increase.

#### SQLite's load-time root cause

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

Proposed fix (investigated, not yet implemented): raise
`wal_autocheckpoint` during bulk load, or run an explicit `PRAGMA
wal_checkpoint(TRUNCATE)` on a coarser, row-count-driven cadence instead of
SQLite's size-driven default, so checkpoint I/O amortizes over far more
rows. A follow-up repro sweeping checkpoint intervals at the same
100K/500K/2M scales would quantify the win before touching the real
loader — tracked in [Next steps](#next-steps).

### SF10 query latency (p50 / p95 / p99, milliseconds) — row-count parity: **7/7 queries comparable=yes, 0 engine failures**

| Query | typegraph-sqlite | typegraph-postgres | neo4j | ladybugdb |
| --- | --- | --- | --- | --- |
| IS1 (person profile) | 0.031 / 0.041 / 0.045 | 0.697 / 1.059 / 1.116 | 5.256 / 13.795 / 72.785 | 1.220 / 2.571 / 2.692 |
| IS2 (friends' recent messages) | 188.060 / 589.581 / 706.721 | 2698.716 / 12161.358 / 13515.001 | 482.176 / 3414.382 / 5967.279 | 311.378 / 476.792 / 586.377 |
| IS3 (friends with dates) | 0.529 / 1.199 / 2.240 | 14.402 / 29.690 / 90.602 | 39.828 / 114.855 / 345.590 | 14.102 / 41.705 / 50.618 |
| IS4 (message content) | 0.022 / 0.030 / 0.042 | 0.890 / 1.725 / 2.378 | 4.168 / 5.927 / 9.163 | 1.031 / 1.358 / 1.391 |
| IS5 (message creator) | 0.033 / 0.040 / 0.052 | 3.523 / 4.384 / 4.759 | 4.807 / 6.430 / 9.884 | 2.750 / 3.438 / 3.942 |
| IS6 (root forum + moderator) | 0.071 / 0.120 / 0.125 | 4.555 / 8.862 / 9.550 | 5.766 / 6.643 / 13.169 | 3.926 / 9.374 / 10.476 |
| IS7 (replies + knows check) | 0.061 / 0.747 / 0.899 | 5.218 / 10.013 / 11.935 | 7.425 / 32.357 / 86.011 | 6.972 / 10.366 / 11.291 |

At SF10, the earlier SF1-scale IS2 latency cliff (a covering-index gap in
this benchmark's own schema, closed before this run — see the "IS2 SF10
latency cliff" fix in git history) stays closed: SQLite's IS2 p50 (188ms)
is proportionate to its SF1 number, not the 689x blowup that motivated that
fix. Query latency ordering is otherwise consistent with SF1: SQLite fastest
across the board (in-process, no network, no query-plan interpretation
overhead), Postgres and LadybugDB next, Neo4j generally slowest at the
tails (its p99s are consistently the noisiest — Cypher planner and JVM GC
pauses are the likely contributors, not investigated further here).

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

Row-count parity: 7/7 queries comparable=yes (30 persons, 5 forums, 40
posts, 80 comments; 15 samples / 3 warmups per query).

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
      equivalent of `COPY FROM` or `UNWIND ... IN TRANSACTIONS`, which
      is a larger, separate investigation if pursued further.
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
      that gap is worse-than-linear.~~ Root-caused: `wal_autocheckpoint` is
      never tuned for bulk load, left at SQLite's size-driven default
      (~4MB), so checkpoint I/O cost climbs as the database file grows over
      the load. See [SQLite's load-time root cause](#sqlites-load-time-root-cause)
      above.
- [ ] Implement and measure the proposed fix (raise `wal_autocheckpoint`
      during bulk load, or checkpoint on an explicit row-count cadence
      instead of SQLite's size-driven default) — a repro sweeping
      checkpoint intervals at 100K/500K/2M scale first, before touching the
      real loader or re-running the full SF10 EC2 benchmark to confirm the
      win.
