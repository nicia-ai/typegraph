# GA_WCC lane — validation of exact WCC (typegraph#272)

Validates the exact weakly-connected-components implementation (label-min on
the #274 D2 iterative substrate) via the benchmark's `GA_WCC` lane, against
pgGraph's native `graph.connected_components`.

## Correctness — fully green

Smoke fixture (31 persons, 240 directed `knows` edges), `--engines=typegraph-sqlite,typegraph-postgres,pggraph`:

- **`GA_WCC: comparable=yes`** — all three engines produce the identical
  person-component size multiset.
- **Cross-backend determinism confirmed:** typegraph-sqlite and
  typegraph-postgres return byte-identical WCC results — the deterministic
  `(id, kind)` component-representative design (code-point / `binaryText`
  comparison, no float tie-breaks) holds across SQLite and PostgreSQL.
- **Cross-engine correctness:** TypeGraph's label-min WCC matches pgGraph's
  native CSR `connected_components`.

Semantic note folded into the driver: `weaklyConnectedComponents` returns every
visible node by default, so Forum/Post/Comment (no `knows` edge) would come back
as isolated singletons. The lane now passes `nodeKinds: ["Person"]`, making the
workload the induced Person subgraph by construction instead of post-filtering
results after TypeGraph has processed unrelated nodes.

## Performance

Per-request median at smoke:

| Engine | Pre-stats fix | Stats fix, all nodes | Scoped WCC + tuned trigger |
| --- | ---: | ---: | ---: |
| pggraph (`graph.connected_components`) | 0.8 ms | 1.1 ms | 0.9 ms |
| typegraph-sqlite | 5.2 ms | 4.9 ms | 4.7 ms |
| **typegraph-postgres** | **1146 ms** | **23.2 ms** | **18.8 ms (~61×)** |

> Post-remediation figures are **measured on the bench branch** (rebased onto
> `feat/wcc-graph-analytics`, `--requests-per-query=15`), not transcribed — the
> earlier "pending" note is resolved. PostgreSQL WCC is now ~4.7× SQLite (the
> ≈5× target), and **`GA_WCC: comparable=yes` still holds** across
> sqlite/postgres/pggraph — the in-transaction `ANALYZE` did not perturb the
> result (a genuine regression check the parity gate performs for free).
> GA_BFS/GA_SSSP also stay `comparable=yes` (7.7/6.8 ms in the latest smoke
> run). Each remediated WCC run emits exactly one `ANALYZE` (~1.5 ms).

### Root cause (corrected)

An earlier version of this note attributed the PostgreSQL cost to network
round-trips; **that was wrong.** Ordinary statements and round-trips total
only ~15 ms. The real cause: PostgreSQL has **no statistics for the freshly
seeded temporary working table**, estimates one row instead of 181, and picks
a deeply nested-loop propagation plan (per round: 181 working-table scans,
~32.8k edge-index probes, ~43.4k node-index probes). Four propagation
statements account for ~1.18 s of the ~1.20 s.

Diagnostic controls (whole-graph seed, smoke):

| Configuration | WCC total |
| --- | ---: |
| Baseline | 1,190–1,220 ms |
| `jit=off` | 1,184–1,208 ms |
| `ANALYZE` after seed | 26–30 ms |
| `enable_nestloop=off` | 23–27 ms |

`ANALYZE` on the temp table costs ~1.5–1.9 ms; afterward PostgreSQL uses
one-pass hash joins and all four rounds total ~10 ms. This is the
community-detection design's §7 / open-Q3 scale caveat made concrete —
the fix is a stale-statistics refresh, not a network or round-trip problem.

### Remediation (implemented in `feat/wcc-graph-analytics`)

A reusable D2 statistics policy in the iterative-graph-operation substrate:

- **Backend seam** for temp-table analysis — PostgreSQL emits `ANALYZE`,
  SQLite is a no-op (it planned fine without it). No inline dialect branching.
- **Initial size threshold of 16 rows** — WCC's scoped 31-person smoke seed
  triggers one `ANALYZE`; BFS/shortest-path's 1–2-row seed does not.
- **Growth-factor re-analysis (4×)** — algorithms whose working table grows
  across rounds (BFS, bidirectional shortest path) track cumulative growth and
  re-analyze when it crosses 4× since the last refresh. Verified on a synthetic
  PostgreSQL BFS growing 1 → 64 → 256, which fired exactly two refreshes.

The first scoped run exposed a second boundary bug: 31 rows fell below the old
64-row trigger and regressed WCC to 160.7 ms despite doing less logical work.
Lowering the generic trigger to 16 rows restored the hash-join plan and brought
the scoped lane to **18.8 ms**, still with one `ANALYZE` per run. This threshold
is evidence-driven rather than algorithm-specific.

### Scale gate: algorithms on PostgreSQL at SF1 — PASSED

The growth-factor re-analysis targets the case smoke can't reach (a working
table that grows well beyond the initial threshold). Full-lane numbers from the
post-merge SF1 run (ref `e095e176`, all 5 engines, 9,892 persons / 361,246
directed / ~180k undirected `knows` edges; `workingMemory: "64MB"` on the
iterative calls):

| Query | tg-sqlite p50 | tg-postgres p50 | pggraph p50 | parity |
| --- | ---: | ---: | ---: | :---: |
| GA_WCC | 11425 ms | 47406 ms | 8.82 ms | `comparable=yes` |
| GA_BFS | 209 ms | 1741 ms | 283 ms | `comparable=yes` |
| GA_SSSP | 211 ms | 1723 ms | 281 ms | `comparable=yes` |

- **No planner cliff.** A stale-stats nested-loop plan over 9,892 nodes / ~180k
  edges across ~7 BFS rounds would run for minutes-to-hours (extrapolating the
  pre-fix 1146 ms at 181 nodes). Bounded seconds means hash joins — the size/4×
  growth-factor `ANALYZE` fires as the frontier grows and keeps the plan off
  nested loops. Combined with the unit test (synthetic 1→64→256, two refreshes)
  this closes the growth-path gate.
- **Reachability optimization confirmed end-to-end.** The predecessor-free
  `reachable()` path (dedup edge targets before the node join, skip the
  shortest-path-only `ROW_NUMBER` ranking) plus #285's iterative-round overhead
  removal bring GA_BFS/GA_SSSP tg-postgres to ~1.7 s — down from the pre-merge
  scale-gate's 2867/2969 ms (~1.6–1.7×). tg-sqlite runs them in ~0.2 s.
- **GA_WCC: architectural, not overhead.** tg-postgres 47.4 s vs pgGraph's
  native CSR union-find 8.82 ms is the SQL-iteration-vs-CSR gap
  (community-detection design §7), not a pathology. #285 + the restored 64MB
  `work_mem` moved it 65.1 → 47.4 s; that undershoots the review's ~15–25 s
  estimate (tight, CV 0%; the `work_mem` override is verified
  transaction-scoped-effective), most plausibly the shared-vCPU EC2 host
  stretching a CPU-bound loop — a dedicated-core confirmation is the open item.
- **Correct at scale.** All three `comparable=yes` vs pgGraph's native CSR —
  TypeGraph's whole-component reachability, min-depth sums, and component-size
  multiset are byte-identical to pgGraph over the SF1 `knows` graph.

See `sf1-results.md` for the full 16-query, 5-engine table and the IC9 PG
`EXPLAIN ANALYZE` fan-out breakdown.

## Lane status

`GA_WCC` is now supported on all engines except ladybug/neo4j-community (which
still declare it unsupported — no connected-components primitive / needs GDS).
TypeGraph's `TYPEGRAPH_UNSUPPORTED` is now empty and removed — TypeGraph runs
all 16 SNB lane queries.
