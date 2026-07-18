# SF1 five-engine comparison + perf investigation

**Post-#288/#293 run** on merged `main` (ref `0331096f`). Adds the **IC14**
weighted-shortest-path lane (#288, a SQLite-vs-Postgres comparison — no
competitor does weighted SP in its available form) and confirms the **#293 WCC
delta-frontier** speedup. Earlier fixes also in: #279 WCC, #282 (#280) node
index, #283 (#281) late materialization, #284 system-index, #285 iterative
levers; iterative algorithm calls pass `workingMemory: "64MB"`. EC2 c7i.4xlarge,
all 5 engines, `--check`. **Parity green** — `failures: []`.

## p50 latency (ms), SF1 (9,892 persons / 361k directed `knows` edges)

Fastest engine per row in **bold**.

| Query | tg-sqlite | tg-postgres | neo4j | ladybug | pggraph |
| --- | --: | --: | --: | --: | --: |
| IS1 | **0.03** | 1.06 | 4.72 | 1.16 | 0.90 |
| IS2 | **1.89** | 19.7 | 75.9 | 62.2 | 18.2 |
| IS3 | **0.24** | 1.42 | 26.2 | 8.52 | 1.38 |
| IS4 | **0.02** | 0.91 | 3.13 | 1.03 | 0.88 |
| IS5 | **0.03** | 1.01 | 4.35 | 2.10 | 0.90 |
| IS6 | **0.08** | 2.18 | 4.94 | 3.94 | 1.78 |
| IS7 | **0.07** | 2.08 | 7.30 | 7.81 | 1.76 |
| IC13 (shortest path) | 2.65 | 22.2 | 11.7 | 8.18 | **2.14** |
| IC14 (weighted SP) | 5153 | **4518** | gap | gap | gap |
| BFS3 | **207** | 1136 | 456 | 2241 | 351 |
| IC2 | **42.0** | 500 | 47.4 | 85.5 | 328 |
| IC8 | **2.89** | 16.3 | 32.1 | 21.8 | 7.30 |
| IC9 | 1940 | 14312 | 2655 | **769** | 3308 |
| GA_DEGREE | **0.05** | 1.04 | 2.77 | 1.86 | 0.81 |
| GA_WCC | 6943 | 22867 | gap | gap | **9.45** |
| GA_BFS | **214** | 1724 | gap | gap | 279 |
| GA_SSSP | **207** | 1643 | gap | gap | 275 |

`gap` = declared unsupported. IC14 gaps: neo4j-community needs GDS, pgGraph's
`graph.shortest_path` is hop-only, ladybug's Kuzu `WSHORTEST` not wired. GA gaps:
neo4j/ladybug have no connected-components / whole-component primitive. Loads:
ladybug 44s, neo4j 70s, pggraph 116s, tg-sqlite 159s, tg-postgres 340s.
Shared-vCPU host (Xeon 8488C, 16 vCPU); treat sub-ms and NOISY (CV>25%) rows as
order-of-magnitude.

### #293 WCC delta frontier — confirmed (tight, CV 0–1%)

GA_WCC dropped from the pre-#293 run: **tg-sqlite 11,425 → 6,943ms (~1.65×)** and
**tg-postgres 47,406 → 22,867ms (~2.07×)**. Postgres improved *more* — confirming
the prediction that the full-table-`UPDATE`/MVCC churn on the (never-vacuumed)
temp working table was the PG-specific penalty #293's in-place delta frontier
removes. Still architectural vs pgGraph's native CSR (9.45ms), just narrower.

### IC14 weighted shortest path — heavy, noisy, PG-favored

IC14 is ~4.5–5.2s (tg-postgres 4,518ms *faster* than tg-sqlite 5,153ms, both
NOISY at CV 29–58%). Unlike IC13 it has no hop bound — a cost-ordered Dijkstra
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
  tg-sqlite 0.05ms; IC9 tg-sqlite ~2.7–3.0s, still ≤ pggraph 3.2s and near
  neo4j 2.5s). IC9 is NOISY, so its ~10% run-to-run drift is within noise.

## The shape

- **IS point reads:** tg-sqlite is fastest (indexed point-read path); pgGraph
  and tg-postgres close; ladybug/neo4j slower.
- **IC9 is competitive on sqlite:** tg-sqlite 2959ms is ≤ pggraph (3193ms) and
  near neo4j (2530ms) after late materialization — ladybug's columnar top-K
  (736ms) still leads.
- **Graph-algorithm / traversal lanes:** pgGraph's native CSR dominates
  (GA_WCC 8.82ms, IC13 1.26ms). TypeGraph's in-database SQL iteration is orders
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
path the generic edge schema lacks. ladybug's columnar vectorized top-K (736ms)
sidesteps the materialization entirely; pgGraph (3.2s, same query shape) confirms
this is the query, not a bug.

## GA_WCC is architectural, not overhead

GA_WCC is exact label propagation on the D2 iterative substrate (rounds of a
window/aggregate over ~180k undirected `knows` edges). **After #293's delta
frontier**, tg-sqlite 6.9s / tg-postgres 22.9s vs pgGraph's native CSR union-find
**9.45ms** — still a 3–4 orders-of-magnitude gap that is the
SQL-iteration-vs-CSR architecture, not removable overhead. #293 nearly halved the
PG figure (47.4 → 22.9s, ~2.07×) by replacing the per-round full-table
reset/apply `UPDATE`s with in-place delta-frontier relaxation — removing the
MVCC churn on the never-vacuumed temp working table (the PG-specific penalty; a
dedicated-core decomposition of the *pre-#293* 47.4s had shown the 64MB
`work_mem` was a no-op at SF1 and ~1.8× was the shared-vCPU host). The residual
is the inherent per-round SQL-iteration cost — no algorithm-preserving change
closes the gap to native CSR.
