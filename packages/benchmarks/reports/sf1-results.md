# SF1 five-engine comparison + perf investigation

**Clean re-run** of the pgGraph-comparison lane (all 5 engines × 16 queries,
`--check`), EC2 runner (c7i.4xlarge), ref `0ea9962b` — the bench branch with
both perf fixes landed (**#280** node `(graph_id, id)` index + **#281** late
materialization) plus the `ec96e39b` gzip-collect fix. **Parity green** —
`failures: []`, every engine produced byte-identical digests for every query at
SF1. Full `results.json` captured this time (no SSM truncation).

## p50 latency (ms), SF1 (9,892 persons / 361k directed `knows` edges)

| Query | tg-sqlite | tg-postgres | neo4j | ladybug | pggraph |
| --- | --: | --: | --: | --: | --: |
| IS1 | 0.03 | 0.95 | 3.68 | 0.99 | 0.82 |
| IS2 | 1.60 | 19.9 | 67.5 | 65.2 | 17.6 |
| IS3 | 0.22 | 1.50 | 7.49 | 5.51 | 1.31 |
| IS4 | 0.02 | 0.89 | 2.86 | 0.64 | 0.79 |
| IS5 | 0.03 | 0.96 | 4.42 | 2.14 | 0.86 |
| IS6 | 0.07 | 1.95 | 4.71 | 3.66 | 1.91 |
| IS7 | 0.06 | 1.83 | 6.88 | 6.47 | 1.68 |
| IC13 (shortest path) | 2.39 | 23.8 | 3.55 | 7.79 | **2.01** |
| BFS3 | 186 | 883 | 417 | 2394 | 310 |
| IC2 | 26.5 | 297 | 34.1 | 67.9 | 200 |
| IC8 | 2.14 | 6.95 | 21.8 | 20.3 | 4.18 |
| IC9 | **2718** | **12290** | 2370 | **694** | 3008 |
| GA_DEGREE | **0.05** | 0.96 | 2.58 | 1.10 | 0.83 |
| GA_WCC | 12437 | 65134 | gap | gap | **8.40** |
| GA_BFS | 188 | 1613 | gap | gap | 247 |
| GA_SSSP | 188 | 1586 | gap | gap | 243 |

`gap` = declared unsupported (neo4j-community/ladybug have no
connected-components / whole-component primitive). Loads: ladybug 40s, neo4j
65s, pggraph 105s, tg-sqlite 149s, tg-postgres 301s. Many cells flagged NOISY
(CV>25%) at 20 samples on a shared-vCPU host — treat sub-ms and high-variance
rows as order-of-magnitude.

## The shape

- **IS point reads:** tg-sqlite is fastest (indexed point-read path is
  excellent); pgGraph and tg-postgres close; ladybug/neo4j slower.
- **IC9 is now competitive on sqlite:** tg-sqlite 2718ms beats pggraph (3008ms)
  and is near neo4j (2370ms) after late materialization — ladybug's columnar
  top-K (694ms) still leads.
- **Graph-algorithm / traversal lanes:** pgGraph's native CSR dominates
  (GA_WCC 8.4ms, IC13 2.0ms). TypeGraph's in-database SQL iteration is orders of
  magnitude slower at scale — the honest specialized-engine vs general-database
  tradeoff.

## Fix outcomes (this run vs. the first run)

- **#280 GA_DEGREE (PR #282): 102ms → 0.05ms on tg-sqlite (~2000×)** — the
  `(graph_id, id)` node index turns the 3.16M-node scan into a point seek.
  tg-sqlite is now the fastest engine on GA_DEGREE.
- **#281 IC9 late materialization (PR #283): 4325ms → 2718ms on tg-sqlite
  (~37%)** — matches the measured content-materialization share. On
  **tg-postgres only 14171ms → 12290ms (~13%, and IC9 is NOISY)**: PG's IC9 is
  **fan-out-bound**, not content-bound — the 1.18M-candidate traversal + join
  dominates, which late materialization doesn't reduce (it only defers
  `content`). tg-postgres IC9 is still ~4× pggraph-on-PG (3008ms).

  **PG `EXPLAIN (ANALYZE, BUFFERS)` (seed with 3,662 FoF, 10.7s) confirms it:**
  98% of the time is a single Nested Loop — an `Index Scan using
  typegraph_nodes_id_idx on n` **looped 1,204,152 times** (`Buffers: hit=4.9M
  read=1.1M`, ~10.4s) that heap-fetches `n.props` per candidate to extract the
  `creationDate` sort key. The edge fan-out (`typegraph_edges_to_idx`,
  index-only, 3,662 loops → 1.2M edges) is 341ms; the top-N heapsort
  (1.18M → 20) and the 20-row deferred re-fetch are trivial. Late materialization
  can't help PG here: the sort key lives *inside* `props`, so the topK
  heap-fetches `props` regardless (and `content` rides along for free) — unlike
  SQLite, where the covering index served `creationDate` index-only and
  `content` was a *separate* heap fetch late-mat removed. Two levers (future
  work): (1) index-only sort-key extraction via
  `snb_message_by_creation_date_covering_idx` (the planner picked
  `(graph_id, id)` over the `(graph_id, kind, id, …)` covering index because the
  join didn't expose `kind`) — drops the ~1.1M heap reads; (2) per-author top-K
  pushdown to shrink the 1.2M fan-out to ~73k (architectural — needs a
  `(creator, creationDate)` access path the generic edge schema lacks). Also
  confirmed: **#280's `typegraph_nodes_id_idx` is used on PG** for the
  `n.id = e.from_id` bare-id join.

## Three TypeGraph-at-scale findings (all perf; parity green)

1. **GA_DEGREE 102ms on SQLite → typegraph#280 (FIXED + verified).** The degree
   query's `nodeKindSubquery` looks up a node by id without its kind; the nodes
   PK is `(graph_id, kind, id)` with no `(graph_id, id)` index, so SQLite seeks
   `graph_id` only and scans all ~3.16M nodes. Fixed by adding a `(graph_id, id)`
   node index (`typegraph_nodes_id_idx`) to both dialect schemas
   (`fix/degree-node-id-index`). Verified end-to-end on real SF1: the bare-id
   lookup now does a direct two-column seek
   (`SEARCH … USING INDEX typegraph_nodes_id_idx (graph_id=? AND id=?)`) and
   `store.algorithms.degree` dropped from ~95ms to **0.06–0.49ms** (~200–1500×).
   PostgreSQL was already 0.2ms; the index is added there too so the bare-id
   access path is indexed rather than planner-luck-dependent.

2. **GA_WCC 11.3s on SQLite** — not a bug; the label-propagation iteration cost
   (~15 rounds × a `ROW_NUMBER` window over 361k `knows` edges per round). The
   community-detection design's §7 in-database-iteration scale caveat, made
   concrete (pgGraph native CSR union-find: 8.8ms). Possible optimization:
   `MIN(...) GROUP BY target` instead of the `ROW_NUMBER` rank-1 window;
   fundamentally still O(rounds × edges).

3. **IC9 4.3s (sqlite) / 14.2s (postgres) — root-caused + quantified.**
   Friends+FoF-messages-before-date. Stage breakdown on real SF1 (seed with
   3,662 FoF authors):

   - `neighbors(depth:2)` is **negligible** — 7–12ms. Not the bottleneck.
   - The two `IN`-list message queries dominate; the **Comment leg** (~2.9s) is
     ~4× the Post leg (~0.6s) — Comments (~2M) outnumber Posts (~1M) with higher
     per-author fan-out.
   - The Comment leg fans out to **1,184,787 candidate comments** (3,662 authors
     × ~324 each), reduced to a top-20 by a full `USE TEMP B-TREE FOR ORDER BY`
     sort. This 1.18M-candidate fan-out is the fundamental cost.
   - Cost isolation (same Comment leg): full+content **2,928ms** vs keys-only
     **1,958ms** → **content materialization is ~970ms (~33%) of pure waste** —
     the flat compiled `SELECT` fetches `content` for all 1.18M candidates and
     carries it through the sorter, then discards all but 20.

   Two findings:

   - **Eager projection / no late materialization → typegraph#281 (FIXED, PR
     #283).** The query compiler emitted a single flat `SELECT` projecting every
     selected column (incl. `content`) for all candidates before the sort.
     Late materialization now sorts on the `(creationDate, id)` keys over a lean
     candidate set and re-fetches `content` for only the 20 survivors.
     **Measured on real SF1: the Comment leg drops ~30% (2.9s → 2.1s)**, `late-mat`
     active; `content` fetched for 20 rows instead of 1.18M. This is also the
     predicted dominant cause of the **postgres 14.2s** (PG drags 1.18M *wide*
     rows through a spilling sort) — confirm on the next PG run.
   - **1.18M fan-out is inherent to the generic edge schema.** Top-K-recent over
     a dynamic author set has no supporting index; a per-author top-20 pushdown
     (index-ordered scan per author → union ~73k → final top-20) would shrink the
     sort input ~16×, but needs a `(creator, creationDate)` ordered access path
     the `hasCreator`-as-edges schema lacks. Architectural — the same
     general-database-vs-specialized-engine story as GA_WCC/IC13; ladybug's
     columnar vectorized top-K (340ms) sidesteps the materialization entirely.
     pgGraph (2.9s, same query shape) confirms this is the query, not a bug.

   Postgres EXPLAIN ANALYZE not yet captured (docker PG was down + tmpfs
   ENOSPC risk on a full load); the late-materialization hypothesis above is the
   predicted dominant cause and is worth confirming on a PG run.
