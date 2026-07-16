---
"@nicia-ai/typegraph": patch
---

Cut three overheads out of the iterative graph algorithms, root-caused with
`EXPLAIN (ANALYZE, BUFFERS)` against LDBC SNB SF1 on PostgreSQL.

Weakly connected components no longer re-validates node visibility per edge in
its propagate rounds. The working table is seeded through the same
graph/kind/temporal filters inside the same snapshot and both edge endpoints
are already joined against it, so membership is the visibility proof; the
per-edge `typegraph_nodes` index loops (hundreds of thousands per round on
SF1) added nothing. Results are byte-identical.

Traversal rounds now carry their own bookkeeping instead of issuing follow-up
statements: seeding returns the frontier through `INSERT … RETURNING`, and
bidirectional shortest-path rounds detect the frontier meeting inside the
expansion statement rather than with a separate probe per round. A
shortest-path traversal that used to issue two to three statements per round
now issues one, roughly halving round-trip latency on latency-bound
connections. The working-table `ANALYZE` policy is unchanged in its
thresholds but no longer runs when no further round will read the table.
When several equal-depth meetings exist, the tie now breaks by node id then
kind in code-unit order on both backends — previously the selection followed
the database collation, so a PostgreSQL cluster with a linguistic default
collation could pick a different (equally shortest) path.

New option: iterative algorithm calls (`reachable`, `shortestPath`,
`canReach`, `neighbors`, `weaklyConnectedComponents`) accept
`workingMemory?: string` (default `"64MB"`), a transaction-scoped memory
budget applied on PostgreSQL with `SET LOCAL work_mem` semantics via
parameterized `set_config`. It prevents whole-graph rounds from spilling
their sorts to disk (measured ~106MB external merges per WCC round on SF1),
never touches the session or server setting, is validated as
`<digits>kB|MB|GB` within PostgreSQL's accepted `work_mem` range
(64kB–2147483647kB) with the same typed error on both backends, and is
ignored by SQLite.
