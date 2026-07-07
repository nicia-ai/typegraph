# Lane 1 (LDBC SNB Interactive short reads) — results

**Status: real SF1-scale numbers, single run — not a publishable comparison
yet.** Per the program plan, SF1 is the minimum scale for any claim about
relative engine performance, and this file now has it: a full run (~9.9k
persons, ~1M posts, ~2.05M comments, official CsvBasic datagen export)
completed cleanly across all four engines with 100% row-count parity on
every query. Treat the numbers below as a first real data point, not a
final verdict — this is one run on one machine, not the multiple runs /
statistical-confidence bar a published comparison would need. The
smoke-scale table is kept below for harness-wiring reference.

Reaching a working SF1 run required finding and fixing three real
scaling bugs (two in TypeGraph itself, one in this benchmark's own
LadybugDB driver) — see
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
`bench-results/current/snb-sf1-ec2-ec2-20260706T215112Z/{summary,results}.json`
(gitignored — regenerate with `pnpm bench:snb:sf1:ec2` then the printed
`collect` command).

## SF1 load time (9,892 persons, 90,492 forums, 1,003,605 posts, 2,052,169 comments)

| Engine | Load time |
| --- | --- |
| ladybugdb | 45.3 s |
| neo4j | 266.9 s (4.4 min) |
| typegraph-sqlite | 4,454.4 s (74.2 min) |
| typegraph-postgres | 4,853.6 s (80.9 min) |

TypeGraph's SQLite/Postgres backends are markedly slower to *load* at this
scale than Neo4j or LadybugDB — both of the latter use engine-native bulk
paths (Neo4j's batched `UNWIND ... IN TRANSACTIONS OF 5000 ROWS`, Ladybug's
`COPY FROM`), while TypeGraph's backends go through the general-purpose
`bulkInsert` API. This is a real, load-bearing difference worth its own
investigation, not something to paper over — filed as a follow-up, not
fixed in this PR (see Next steps).

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

**IS2 numbers above predate a follow-up optimization** (see below) and will
be superseded on the next full EC2 run.

### IS2 follow-up: parallelize the per-message root walk

IS2's root-post walk (`resolveRootPostId` + `authorOfPost`) ran once per
message, sequentially, in a plain `for` loop — up to 10 independent
round-trips paid one after another. Each message's walk has no dependency
on any other message's, so it now runs concurrently via `Promise.all`
(`src/real/engines/typegraph-queries.ts`) instead. No query shape changed;
only the orchestration around already-existing prepared queries did.

Before trusting this, we first considered whether the real fix was
elsewhere — an apparent SQLite planner issue (`.in(friendIds)` picking a
table scan over an index) turned out to be an artifact of a test missing
`store.refreshStatistics()`, not a real bug; once statistics were fresh,
the planner already chose correctly. That ruled out a planner-level
generalizable win and left concurrency as the change worth making.

Verified in two stages against the real, cached SF1 dataset:

1. **Row-count parity**: unaffected, both at smoke scale and a full SF1 run
   (100% comparable across all 7 queries in both cases).
2. **Same-machine controlled A/B** (a laptop under normal contention — not
   the dedicated EC2 box used for the table above, so *not* directly
   comparable to those absolute numbers): sequential vs. parallel IS2 on
   `typegraph-sqlite`, same dataset, same run of the harness either side of
   the change —

   | | p50 | p95 | p99 |
   | --- | --- | --- | --- |
   | Sequential (before) | 602.8 ms | 1939.3 ms | 2328.8 ms |
   | Parallel (after) | 336.0 ms | 1100.3 ms | 1418.6 ms |

   A first attempt to judge this by comparing the parallel run against the
   EC2-measured table above looked like a 4x *regression* — that comparison
   was invalid (different machine entirely; this laptop's sequential IS2 is
   itself ~7x slower than EC2's). The only valid same-machine comparison
   shows parallelization winning by ~1.8x, not regressing.

`typegraph-postgres` showed a similar directional improvement against the
EC2-measured baseline (203.229 / 605.720 / 876.873 ms → 131.5 / 426.9 /
615.6 ms, same laptop), consistent with overlapping round-trip latency
across a connection pool, though no same-machine sequential baseline was
taken for Postgres to isolate the effect as cleanly as SQLite's.

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
- [ ] Investigate why TypeGraph's SQLite/Postgres backends load ~65-100x
      slower than Neo4j/LadybugDB at SF1 scale (both of which use an
      engine-native bulk path TypeGraph's `bulkInsert` doesn't have an
      equivalent of yet).
- [x] ~~Parallelize IS2's sequential per-message root walk.~~ Done — see
      [IS2 follow-up](#is2-follow-up-parallelize-the-per-message-root-walk)
      above. Verified functionally (row-count parity, smoke + full SF1) and
      directionally (same-machine A/B); not yet re-measured on EC2.
- [ ] Re-run the full SF1 EC2 benchmark to capture clean, comparable IS2
      numbers reflecting the parallelization above, and update the query
      latency table.
- [ ] Run SF1 multiple times and report a distribution, not a single
      sample, before making any comparative claim publicly.
- [ ] SF10 remains a stretch goal per the plan, gated on SF1 numbers being
      trusted (multi-run, not single-sample).
