---
"@nicia-ai/typegraph": patch
---

Hard-deleting a node no longer scans every edge in the graph on a SQLite database without planner statistics. Three statements find a node's edges at either endpoint: the edge delete that `hardDelete` runs, history capture's selection of the edges that delete removes (on stores with history enabled), and the live-edge check in the batched node delete. All three matched `graph_id = ? AND ((from side) OR (to side))`. With no `sqlite_stat1`, SQLite planned the shared `graph_id` equality as a range over `typegraph_edges_to_idx` and walked the graph's edges for every deleted node: about 19 ms per hard delete at 200k edges. All three now repeat the graph equality inside each side, so every plan SQLite can choose seeks `typegraph_edges_from_idx` and `typegraph_edges_to_idx`. That brings the delete down to about 0.1 ms, with or without statistics. PostgreSQL plans the new form exactly as before. Self-loop edges are deleted once, as before.
