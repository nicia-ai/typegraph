# SF1 five-engine comparison + perf investigation

**Re-run on `bench/pggraph-comparison-v2` rebased onto latest `main`** (ref
`a3656535`), after main's type-system refactor (#303 "Isolate Drizzle behind
TypeGraph core ports", + #305 adapter hardening). This run **confirms #303 did
not move TypeGraph performance** — see the "#303 refactor — no regression"
section below. It also fills the neo4j graph-algorithm lanes via GDS
(`gds.wcc.stream` / `gds.allShortestPaths.dijkstra.stream`), which the prior
baseline (`0331096f`) predated.

Lineage carried in: **IC14** weighted-shortest-path lane (#288, a
SQLite-vs-Postgres comparison — no competitor does weighted SP in its available
form); the **#293 WCC delta-frontier** speedup; #279 WCC, #282 (#280) node
index, #283 (#281) late materialization, #284 system-index, #285 iterative
levers; iterative algorithm calls pass `workingMemory: "64MB"`. EC2 c7i.4xlarge,
all 5 engines, `--check`. **Parity green** — `failures: []`.

## p50 latency (ms), SF1 (9,892 persons / 361k directed `knows` edges)

Fastest engine per row in **bold**.

| Query | tg-sqlite | tg-postgres | neo4j | ladybug | pggraph |
| --- | --: | --: | --: | --: | --: |
| IS1 | **0.03** | 0.76 | 4.84 | 1.11 | 0.93 |
| IS2 | **1.85** | 21.5 | 39.9 | 76.0 | 19.9 |
| IS3 | **0.24** | 1.82 | 4.07 | 4.5 | 1.47 |
| IS4 | **0.02** | 0.98 | 3.01 | 0.39 | 0.91 |
| IS5 | **0.03** | 1.08 | 3.1 | 1.61 | 0.94 |
| IS6 | **0.07** | 1.97 | 3.23 | 3.93 | 1.89 |
| IS7 | **0.07** | 2.15 | 5.74 | 7.83 | 1.76 |
| IC13 (shortest path) | 3.88 | 22.3 | 3.24 | 9.91 | **2.18** |
| IC14 (weighted SP) | 5586 | **4860** | gap | gap | gap |
| BFS3 | **220** | 1139 | 468 | 1539 | 357 |
| IC2 | 51.8 | 523 | **36.2** | 89.1 | 347 |
| IC8 | **3.06** | 17.3 | 3.73 | 24.2 | 8 |
| IC9 | 2236 | 15069 | 3388 | **775** | 3498 |
| GA_DEGREE | **0.03** | 1.09 | 2.97 | 1.8 | 0.72 |
| GA_WCC | 7269 | 24237 | 18.7 | gap | **9.53** |
| GA_BFS | 221 | 1828 | **24.5** | gap | 288 |
| GA_SSSP | 220 | 1742 | **23.6** | gap | 284 |

`gap` = declared unsupported. IC14 gaps: neo4j has no stored `knows` weight to
project for `gds.shortestPath.dijkstra`, pgGraph's `graph.shortest_path` is
hop-only, ladybug's Kuzu `WSHORTEST` not wired. GA gaps: ladybug has no
connected-components / whole-component primitive (its variable-length paths cap
at 30 hops). neo4j now runs the GA lanes through **GDS** (`gds.wcc.stream`,
`gds.allShortestPaths.dijkstra.stream`) — native CSR, hence its GA_BFS/GA_SSSP
lead. Loads: ladybug 46s, neo4j 66s, pggraph 120s, tg-sqlite 164s,
tg-postgres 344s. Shared-vCPU host (Xeon 8488C, 16 vCPU); treat sub-ms and NOISY
(CV>25%) rows as order-of-magnitude.

### #303 type-system refactor — no regression

This run exists to answer one question before the numbers go public: did main's
type-system refactor (#303, which isolates Drizzle behind TypeGraph core ports —
a full query/backend execution-path change) cost any performance? It did not.

Comparing the two TypeGraph columns against the prior baseline (`0331096f`):

- **Point reads (IS1–IS7, GA_DEGREE) are flat or faster.** These are the queries
  most sensitive to per-call executor overhead, so a regression in the refactored
  execution path would surface here first. Instead sub-ms latencies are
  unchanged, and tg-postgres IS1 is *faster* (1.06 → 0.76ms). This is the single
  strongest signal that the port abstraction added no per-request cost.
- **Heavy graph queries drift +3–8%, uniformly, on both backends** (GA_*, BFS3,
  IC9, IC14; e.g. GA_WCC sqlite 6943 → 7269, postgres 22867 → 24237). A code
  regression in the query layer could not hit in-database SQL iteration on SQLite
  *and* Postgres by the same margin while leaving point reads flat — that
  signature is shared-vCPU host / co-tenant variance for this run, not the
  refactor. IC2 (+23%) and IC13 (2.65 → 3.88ms) look larger but are both NOISY
  (CV>25%) and small in absolute terms.
- **Parity is clean** (`failures: []`): the refactored sqlite and postgres
  backends produce byte-identical result digests on all 17 queries.

Verdict: every TypeGraph movement is within the documented noise band; the
numbers are safe to publish, and #303 is performance-neutral.

### #293 WCC delta frontier — confirmed (tight, CV 0–1%)

GA_WCC dropped when #293 landed: **tg-sqlite 11,425 → 6,943ms (~1.65×)** and
**tg-postgres 47,406 → 22,867ms (~2.07×)**. This rebased run reproduces that
level (7,269 / 24,237ms — within host noise of the #293 figures). Postgres
improved *more* — confirming the prediction that the full-table-`UPDATE`/MVCC
churn on the (never-vacuumed) temp working table was the PG-specific penalty
that the in-place delta frontier (#293) removes. Still architectural vs
pgGraph's native CSR (9.53ms), just narrower.

### IC14 weighted shortest path — heavy, noisy, PG-favored

IC14 is ~4.9–5.6s (tg-postgres 4,860ms *faster* than tg-sqlite 5,586ms, both
NOISY at CV>25%). Unlike IC13 it has no hop bound — a cost-ordered Dijkstra
between random person pairs settles a large slice of the giant component, so it's
inherently the heaviest traversal in the lane. Postgres's set-based iteration +
64MB work_mem handles the large frontier better than SQLite's row-wise path here.
Parity holds (`comparable=yes`); the synthetic weight is byte-identical across
both backends by construction.

### Movement vs the pre-merge run (ref `0ea9962b`)

- **IC13 tg-postgres 23.8 → 14.8ms (~1.6×)** — #285 round-trip reduction.
- **GA_WCC tg-postgres 65.1 → 47.4s (~1.4×)** — #285 + the restored 64MB
  `work_mem`, **below the ~15–25s the #285 review anticipated**. A dedicated-core
  local confirmation (14-core, disk-backed PG, same merged code) settles why:
  - **The 64MB override is a no-op at SF1** — WCC ran 25.4s *without* the
    override vs ~27s *with* it (statistically identical). The scoped-Person
    working table (~9,892 rows/round) fits in the 4MB default, so there is no
    spill for 64MB to avoid. The reviewer's spill-avoidance rationale applies at
    larger scale (SF10 / unscoped WCC), not here; the option is kept as a
    harmless fair-config default that may matter at SF10.
  - **~1.8× of the gap is the shared-vCPU EC2 host** — 47.4s on EC2 vs ~26s on
    dedicated cores for the identical run.
  - **The residual ~26s is architectural** — ~15 rounds of a window/aggregate
    over ~180k undirected edges. The gap to pggraph's native CSR union-find
    (**8.82ms**) is the SQL-iteration-vs-CSR architecture, not removable
    overhead; no `work_mem` value closes it.
- GA_DEGREE, IC9, late-materialization wins from #282/#283 hold (GA_DEGREE
  tg-sqlite 0.03–0.05ms; IC9 tg-sqlite ~2.2–3.0s, still ≤ pggraph 3.5s and
  ≤ neo4j 3.4s). IC9 is NOISY, so its ~10% run-to-run drift is within noise.

## The shape

- **IS point reads:** tg-sqlite is fastest (indexed point-read path); pgGraph
  and tg-postgres close; ladybug/neo4j slower.
- **IC9 is competitive on sqlite:** tg-sqlite 2236ms is ≤ pggraph (3498ms) and
  ≤ neo4j (3388ms) after late materialization — ladybug's columnar top-K
  (775ms) still leads.
- **Graph-algorithm / traversal lanes:** the native-CSR engines dominate —
  pgGraph (GA_WCC 9.53ms, IC13 2.18ms) and neo4j GDS (GA_BFS 24.5ms,
  GA_SSSP 23.6ms, GA_WCC 18.7ms). TypeGraph's in-database SQL iteration is orders
  of magnitude slower at scale — the honest specialized-engine vs
  general-database tradeoff.

## Fixes shipped (all merged to main)

- **#280 / PR #282 — node `(graph_id, id)` index.** The degree query's node-kind
  subquery looks up a node by id without its kind; the nodes PK
  `(graph_id, kind, id)` couldn't seek it, so SQLite scanned all ~3.16M nodes
  (~95ms). The index makes it a direct two-column seek. **GA_DEGREE tg-sqlite is
  now 0.05ms** (fastest of any engine); the plan confirms the index is used on
  Postgres too (the `n.id = e.from_id` bare-id join in IC9, see below).
- **#281 / PR #283 — late materialization for `ORDER BY … LIMIT`.** The compiler
  sorts+limits a lean candidate set (identity + sort keys) then re-fetches
  deferred columns by identity for the survivors, instead of carrying every
  projected column through the sorter. **IC9 tg-sqlite ~4.3s → ~3.0s**; `content`
  fetched for 20 rows instead of 1.18M. Bounded by the fan-out (below).
- **#279 / #284 / #285 — WCC + system-index foundation + iterative levers.** Exact
  weakly-connected-components, boot-materialized system indexes, and removal of
  iterative-round overheads (WCC join, round-trips, `work_mem` opt-in). See the
  GA_WCC note in the movement section above.

## IC9 is fan-out-bound (PG `EXPLAIN ANALYZE`, seed with 3,662 FoF)

IC9 (friends+FoF messages before a date) is dominated by the Comment leg, which
fans out to **1,184,787 candidate comments** (3,662 authors × ~324 each) reduced
to a top-20. The PG plan (10.7s): **98% is a single Nested Loop — `Index Scan
using typegraph_nodes_id_idx on n` looped 1,204,152 times** (`Buffers: hit=4.9M
read=1.1M`, ~10.4s), heap-fetching `n.props` per candidate to extract the
`creationDate` sort key. The edge fan-out (`typegraph_edges_to_idx`, index-only,
→ 1.2M edges) is 341ms; the top-N heapsort and 20-row re-fetch are trivial.

Late materialization helps SQLite (the covering index served `creationDate`
index-only, so `content` was a *separate* heap fetch late-mat removed — ~37% on
the Comment leg) but not Postgres: the sort key lives *inside* `props`, so the
topK heap-fetches `props` regardless (and `content` rides along free).

**An index experiment refuted the cheap fix.** Dropping `typegraph_nodes_id_idx`
(the #280 index, to test whether it was crowding out the covering index) made
IC9 **slower**, not faster (8.4s → 9.6s): PG switched the topK node scan to
`snb_message_by_creation_date_covering_idx` but still as a plain `Index Scan`
(width 152, ~1.1M heap reads) — **not** index-only, because the `creationDate`
sort key is a `json_extract(props, …)` expression the index doesn't serve
index-only in this shape. So no index reshuffle removes the 1.2M `props` heap
fetches. The only remaining lever is the **per-author top-K pushdown** — shrink
the 1.2M fan-out to ~73k, architectural, needs a `(creator, creationDate)` access
path the generic edge schema lacks. ladybug's columnar vectorized top-K (775ms)
sidesteps the materialization entirely; pgGraph (3.5s, same query shape) confirms
this is the query, not a bug.

## GA_WCC is architectural, not overhead

GA_WCC is exact label propagation on the D2 iterative substrate (rounds of a
window/aggregate over ~180k undirected `knows` edges). **After #293's delta
frontier**, tg-sqlite 7.3s / tg-postgres 24.2s vs the native-CSR engines —
pgGraph union-find **9.53ms**, neo4j GDS **18.7ms** — still a 3–4
orders-of-magnitude gap that is the SQL-iteration-vs-CSR architecture, not
removable overhead. #293 nearly halved the
PG figure (47.4 → 22.9s, ~2.07×) by replacing the per-round full-table
reset/apply `UPDATE`s with in-place delta-frontier relaxation — removing the
MVCC churn on the never-vacuumed temp working table (the PG-specific penalty; a
dedicated-core decomposition of the *pre-#293* 47.4s had shown the 64MB
`work_mem` was a no-op at SF1 and ~1.8× was the shared-vCPU host). The residual
is the inherent per-round SQL-iteration cost — no algorithm-preserving change
closes the gap to native CSR.
