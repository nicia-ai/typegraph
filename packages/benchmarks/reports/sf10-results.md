# SF10 five-engine comparison

LDBC SNB **SF10** (65,645 persons / 3.88M directed `knows` / 7.44M posts /
21.87M comments — ~10× SF1), ref `57c64a76` (IC14 + #293 + the SF10 disk fixes
below). EC2 `r7i.4xlarge` (128 GB). **Parity green** — `failures: []` on both
component runs.

Assembled from two runs (see "Operational" below): the 4 server/embedded engines
(tg-postgres, neo4j, ladybug, pgGraph) from `ec2-20260718T062800Z`, and tg-sqlite
+ ladybug from a `--check` fill-in `ec2-20260718T162911Z`. The two runs' ladybug
numbers agree within shared-vCPU noise, so the merge is sound; tg-sqlite's SF10
correctness is verified by the fill-in's `--check` against ladybug.

## p50 latency, SF10

Fastest engine per row in **bold**. `s` = seconds.

| Query | tg-sqlite | tg-postgres | neo4j | ladybug | pggraph |
| --- | --: | --: | --: | --: | --: |
| IS1 | **0.03** | 1.06 | 5.22 | 1.12 | 0.93 |
| IS2 | **2.35** | 77.2 | 133 | 104 | 22.6 |
| IS3 | **0.42** | 6.23 | 53.8 | 15.7 | 1.87 |
| IS4 | **0.03** | 0.91 | 3.33 | 0.90 | 0.96 |
| IS5 | **0.04** | 8.67 | 5.52 | 2.68 | 0.96 |
| IS6 | **0.07** | 3.69 | 8.09 | 5.50 | 2.02 |
| IS7 | **0.07** | 7.29 | 8.23 | 8.38 | 1.80 |
| IC13 (shortest path) | 35.0 | 339 | 82.2 | 161 | **2.25** |
| IC14 (weighted SP) | 74.6s | **57.3s** | gap | gap | gap |
| BFS3 | **1.7s** | 7.2s | 3.9s | 9.3s | 2.2s |
| IC2 | 141 | 724 | **138** | 296 | 843 |
| IC8 | **5.24** | 220 | 92.1 | 47.6 | 15.3 |
| IC9 | 11.9s | 76.7s | 15.5s | **3.1s** | 25.4s |
| GA_DEGREE | **0.06** | 1.05 | 3.02 | 2.07 | 0.82 |
| GA_WCC | 119.9s | 506.0s | gap | gap | **69.0** |
| GA_BFS | 2.8s | 22.3s | gap | gap | **2.0s** |
| GA_SSSP | 2.8s | 22.3s | gap | gap | **1.9s** |

IC14 gaps: neo4j needs GDS, pgGraph's `graph.shortest_path` is hop-only, ladybug
`WSHORTEST` not wired. GA gaps: neo4j/ladybug have no connected-components /
whole-component primitive. Loads: ladybug 373s, neo4j 409s, pggraph 1,119s,
tg-sqlite 2,199s, tg-postgres 3,278s (~55 min). Shared-vCPU host — sub-ms and
NOISY (CV>25%) rows are order-of-magnitude.

## The shape at 10×

- **tg-sqlite owns the point reads** (IS1–7 sub-ms vs 1–130ms) and GA_DEGREE /
  IC8 / BFS3 — its indexed in-process path scales cleanly.
- **pgGraph's native CSR owns the graph algorithm & traversal lanes** — GA_WCC
  69ms, IC13 2.25ms, GA_BFS/SSSP ~2ms, barely moving from SF1. ladybug's columnar
  top-K owns IC9 (3.1s); neo4j edges IC2.
- **The SQL-iteration-vs-CSR gap *widens* at scale.** GA_WCC-postgres 22.9s →
  506s from SF1→SF10 (~22× for 10× data — superlinear: rounds × edges). vs
  pgGraph's 9.45 → 69ms (~7×). At SF10 the gap is ~1,700× (sqlite) / ~7,300×
  (postgres) — the honest specialized-engine-vs-general-database story, sharper
  at scale, not removable overhead.

## tg-sqlite beats tg-postgres on the heavy graph queries at scale

The most interesting cross-backend result: for the iterative/fan-out graph
queries, **in-process SQLite pulls ahead of networked Postgres at SF10**:

| Query | tg-sqlite | tg-postgres | sqlite advantage |
| --- | --: | --: | --: |
| GA_WCC | 119.9s | 506.0s | ~4.2× |
| IC9 | 11.9s | 76.7s | ~6.4× |
| GA_BFS / GA_SSSP | 2.8s | 22.3s | ~8× |
| BFS3 | 1.7s | 7.2s | ~4.3× |

Both backends run the identical logical D2 algorithm, so the gap is a
PostgreSQL-specific execution constant factor — **but its cause is not yet
established, and it is not "round-trip overhead."** Three facts rule that out:
GA_BFS/GA_SSSP already issue exactly one `INSERT … RETURNING` per round
(regression-tested in `algorithms.test.ts`), so there is nothing to collapse;
PostgreSQL is reached over loopback (~1ms point queries), so ~tens of exchanges
can't explain hundreds of seconds; and **the PG/SQLite ratio is stable — ~8.1×
at SF1, ~8.0× at SF10 for BFS/SSSP** — which is the signature of a per-row/
per-edge executor + temporary-relation cost, not a fixed tax that compounds with
scale. (An earlier WCC investigation already corrected a network attribution:
round trips were ~15ms; the real cliff then was missing temp-table statistics.)
The one concrete *reducible* lead is that WCC still does **two temporary-table
update passes per round** (`weakly-connected-components.ts:121`) — a plausible
write-amplification win, but its upside is unmeasured (a server-side loop keeps
the same MVCC work). **SQLite is the faster TypeGraph backend for the graph
lanes at this scale; quantifying and reducing PG's D2 constant factor is an open
investigation, not an established removable overhead.** (Postgres still wins the
weighted-Dijkstra IC14.)

## IC14 (weighted shortest path, #288)

tg-postgres 57.3s / tg-sqlite 74.6s — the heaviest single query in the lane. An
*unbounded* cost-ordered Dijkstra between random person pairs settles a large
slice of the 3.9M-edge giant component; at 10× it's ~13× the SF1 cost. Postgres
wins here (set-based frontier expansion parallelizes; SQLite's row-wise settle
does not). Parity holds via the synthetic edge weight.

## Operational — SF10 disk failures + fixes

Two disk issues surfaced (both fixed on ref `57c64a76`):

1. **Anonymous PG volume leak.** `docker rm -f` (without `-v`) left each PG
   container's `/var/lib/postgresql/data` volume behind; at ~70 GB (tg-postgres)
   + ~40 GB (pgGraph) they overflowed the 150 GiB disk before the last engine
   loaded. Fixed with `rm -f -v` in `postgres-container.ts` + `pggraph.ts`.
2. **tg-sqlite's SF10 DB exceeds 150 GiB.** Even with no PG containers, tg-sqlite
   alone (~90 GB DB + load-time WAL, on top of the ~15 GB dataset + OS/repo)
   overflowed 150 GiB. The fill-in used a **500 GiB** volume. The runner's
   `DEFAULT_VOLUME_SIZE_GIB` (150) is fine for SF1 but too small for SF10 — the
   SF10 profile should default to ~400–500 GiB.
