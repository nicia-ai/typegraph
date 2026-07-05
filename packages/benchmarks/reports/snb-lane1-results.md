# Lane 1 (LDBC SNB Interactive short reads) — first results

**Status: smoke-scale only. Not a publishable comparison.** Per the
program plan, SF1 is the minimum scale for any claim about relative engine
performance — the numbers below are from the tiny 30-person/40-post/
80-comment committed smoke fixture, run only to prove the harness and all
four query implementations are wired correctly end-to-end. Treat every
number in this file as "the code runs and agrees across engines," not as
"engine X is faster than engine Y." See [Finding: SF1 load does not
complete in practical time](#finding-sf1-bulk-load-does-not-complete-in-a-practical-time)
below for why there are no SF1 numbers yet.

## Environment (non-publishable iteration hardware)

| | |
| --- | --- |
| Date | 2026-07-05 |
| Machine | Apple M4 Pro, 14 cores, 48 GiB RAM, macOS (darwin/arm64) |
| Node.js | v24.18.0 |
| `@nicia-ai/typegraph` | 0.34.0 |
| `better-sqlite3` | 12.11.1 |
| `pg` | 8.22.0 |
| `neo4j-driver` | 6.2.0 (server image `neo4j:2026.05.0`) |
| `@ladybugdb/core` | 0.18.0 |
| Command | `tsx src/real/snb-short-reads.ts --profile=smoke --check` |
| Samples / warmups | 15 / 3 per query (smoke profile defaults) |

Full machine-readable detail: `bench-results/current/snb-smoke/summary.json`,
`results.json`, `competitor-doctor.json` (gitignored — regenerate with
`pnpm --filter @nicia-ai/typegraph-benchmarks bench:snb:smoke:check`).

## Load time (smoke fixture: 30 persons, 5 forums, 40 posts, 80 comments)

| Engine | Load time |
| --- | --- |
| typegraph-sqlite | 28.1 ms |
| ladybugdb | 67.3 ms |
| typegraph-postgres | 185.0 ms (includes imperative container startup) |
| neo4j | 5993.2 ms (includes imperative container startup + constraint/index `awaitIndexes`) |

At this scale, load time is dominated by fixed setup costs (container
startup, schema bootstrap), not row count — not meaningful for comparison.

## Query latency (p50 / p95, milliseconds) — row-count parity: **7/7 queries comparable=yes**

Every engine returned an identical result-set size for every one of the 15
sampled requests, for all seven queries — the row-count parity gate never
failed. This is the headline result of this run: **the TypeGraph query
builder implementation, the Cypher implementations for Neo4j and
LadybugDB, and the harness's shared request sampling are all semantically
consistent with each other.**

| Query | typegraph-sqlite | typegraph-postgres | neo4j | ladybugdb |
| --- | --- | --- | --- | --- |
| IS1 (person profile) | 0.018 / 0.034 | 0.291 / 0.375 | 2.279 / 7.224 | 0.162 / 0.197 |
| IS2 (friends' recent messages) | 3.342 / 4.701 | 4.938 / 9.972 | 19.789 / 72.974 | 5.232 / 8.968 |
| IS3 (friends with dates) | 0.190 / 0.193 | 0.288 / 0.315 | 1.921 / 4.935 | 0.487 / 0.601 |
| IS4 (message content) | 0.008 / 0.012 | 0.246 / 0.310 | 1.443 / 3.389 | 0.128 / 0.209 |
| IS5 (message creator) | 0.177 / 0.181 | 0.270 / 0.381 | 1.569 / 21.946 | 0.247 / 0.370 |
| IS6 (root forum + moderator) | 0.314 / 0.328 | 0.897 / 1.227 | 1.583 / 4.525 | 1.060 / 1.282 |
| IS7 (replies + knows check) | 0.756 / 0.906 | 1.080 / 2.249 | 3.804 / 48.804 | 1.225 / 2.253 |

Most of these are sub-millisecond and several are flagged noisy
(coefficient of variation > 25% — see `results.json`'s `noisy` field per
query/engine); at smoke scale, absolute timing is dominated by
process/JIT/connection noise, not engine or query-plan characteristics.
Neo4j's p95s in particular reflect per-request Bolt round-trips over a
multi-statement query (IS2/IS7), not a query-plan cost — expected to look
very different at SF1 where the fixed per-request overhead amortizes over
real work.

## Finding: SF1 bulk load does not complete in a practical time

Attempted a real LDBC SF1 run (~9.9k persons, ~1M posts, ~2.05M comments,
via the official CsvBasic datagen export) against all four engines. The
`typegraph-sqlite` load got through persons (9,892), knows edges (361,246
directed), forums (90,492), and posts (1,003,605 + their `hasCreator`/
`containerOf` edges) in 46 minutes, then ran for **over 4.5 hours** on the
comments stage (2,052,170 rows) without finishing — killed after
confirming the process was still actively writing (not deadlocked; the
SQLite file was still growing) but at a rate that would have taken many
more hours.

Isolated with three controlled reproductions (60k-row synthetic loads,
`store.nodes.<Kind>.bulkInsert()`/`store.edges.<kind>.bulkInsert()`, not
hand SQL):

1. A single node kind with no edges shows **flat per-batch time** across
   60k rows (fixed 2,000-row batches stay in the 25–75ms range throughout).
2. The SNB schema (Person/Forum/Post/Comment + knows/hasCreator/
   containerOf/replyOf, including the `Message` ontological supertype)
   shows **per-batch time growing roughly linearly with cumulative rows
   already loaded** — a fixed 2,000-row batch costs ~116ms at row 0 and
   ~569ms at row 58,000 (~5x), which integrates to O(n²) total bulk-load
   time instead of the expected O(n).
3. Removing the `Message` ontology (`subClassOf`) entirely — keeping only
   the polymorphic `hasCreator`/`replyOf` edge declarations — reproduces
   essentially the same growth (~197ms → ~544ms over the same range),
   ruling out the ontology/`includeSubClasses` machinery as the primary
   cause.
4. The slowdown appears even on edges whose target table never grows
   (`hasCreator`'s target is a single fixed Person row throughout), which
   points at something scaling with total graph size (or a specific
   auxiliary table) rather than with the size of the specific table an
   edge references. `typegraph_node_uniques` (the one bookkeeping table
   with a `concrete_kind` column) was checked directly and confirmed
   empty/uninvolved for this schema (no unique constraints declared), so
   it is not the mechanism — the actual cause is unidentified.

This is filed as a finding for the TypeGraph maintainers, not fixed here
(this is a benchmarks-only PR; see
`docs/design/benchmark-program-plan.md`'s explicit no-library-changes
scope). It blocks Lane 1's SF1 run — the headline scale the plan calls
for — until resolved. Recommend profiling `bulkInsert` (nodes and edges)
against a multi-node-kind graph with cross-kind edges at increasing
cumulative row counts to localize the source of the per-batch growth.

## Next steps

- [ ] TypeGraph maintainers investigate the bulk-load scaling finding above.
- [ ] Re-run `bench:snb:sf1` once resolved; replace this doc's smoke-scale
      table with real SF1 numbers before making any comparative claim.
- [ ] SF10 remains a stretch goal per the plan, gated on SF1 being green.
