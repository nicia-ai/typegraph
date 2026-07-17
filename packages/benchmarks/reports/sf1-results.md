# SF1 five-engine comparison + perf investigation

**Post-merge re-run** on merged `main` (ref `e095e176`) — all lane-surfaced
fixes landed: #279 WCC, #282 (#280) node index, #283 (#281) late
materialization, #284 system-index foundation, #285 iterative-algorithm levers.
Iterative algorithm calls now pass `workingMemory: "64MB"` explicitly (the
library no longer defaults it as of #285). EC2 c7i.4xlarge, all 5 engines × 16
queries, `--check`. **Parity green** — `failures: []`.

## p50 latency (ms), SF1 (9,892 persons / 361k directed `knows` edges)

Fastest engine per row in **bold**.

| Query | tg-sqlite | tg-postgres | neo4j | ladybug | pggraph |
| --- | --: | --: | --: | --: | --: |
| IS1 | **0.04** | 0.16 | 3.43 | 0.36 | 0.09 |
| IS2 | **1.95** | 6.03 | 48.7 | 33.4 | 3.27 |
| IS3 | **0.25** | 0.92 | 17.8 | 3.74 | 0.54 |
| IS4 | **0.02** | 0.12 | 1.44 | 0.24 | 0.09 |
| IS5 | **0.03** | 0.17 | 2.67 | 1.38 | 0.10 |
| IS6 | **0.07** | 0.32 | 3.43 | 1.59 | 0.19 |
| IS7 | **0.08** | 0.35 | 3.67 | 3.68 | 0.19 |
| IC13 (shortest path) | 2.97 | 14.8 | 6.97 | 7.32 | **1.26** |
| BFS3 | **204** | 962 | 461 | 704 | 355 |
| IC2 | **28.4** | 339 | 31.0 | 68.8 | 223 |
| IC8 | **2.65** | 7.32 | 16.3 | 13.5 | 4.17 |
| IC9 | 2959 | 13919 | 2530 | **736** | 3193 |
| GA_DEGREE | **0.05** | 0.19 | 1.34 | 0.70 | 0.08 |
| GA_WCC | 11425 | 47406 | gap | gap | **8.82** |
| GA_BFS | **209** | 1741 | gap | gap | 283 |
| GA_SSSP | **211** | 1723 | gap | gap | 281 |

`gap` = declared unsupported (neo4j-community/ladybug have no
connected-components / whole-component primitive). Loads: ladybug 42s, neo4j
62s, pggraph 118s, tg-sqlite 160s, tg-postgres 346s. Shared-vCPU host
(Xeon 8488C, 16 vCPU); treat sub-ms and NOISY (CV>25%) rows as order-of-magnitude.

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

GA_WCC is exact label propagation on the D2 iterative substrate (~15 rounds of a
window/aggregate over ~180k undirected `knows` edges). tg-sqlite 11.4s /
tg-postgres 47.4s vs pgGraph's native CSR union-find **8.82ms** — a 3–4
orders-of-magnitude gap that is the SQL-iteration-vs-CSR architecture, not
removable overhead. A dedicated-core local confirmation decomposes the
tg-postgres figure: the 64MB `work_mem` override is **a no-op at SF1** (25.4s
without vs ~27s with — the scoped-Person working table fits the 4MB default, no
spill to avoid; kept as a fair-config default that may matter at SF10); the
shared-vCPU EC2 host accounts for ~1.8× (47.4s EC2 vs ~26s dedicated); and the
residual ~26s is the inherent iteration cost. No `work_mem` value closes the gap
to native CSR.
