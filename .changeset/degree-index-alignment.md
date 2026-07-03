---
"@nicia-ai/typegraph": patch
---

`degree()` direction filters are now shaped for the default edge indexes.
The filters previously compiled to bare `from_id = ?` / `to_id = ?`, which
neither composite edge index can seek (both lead with the endpoint kind
column) — so degree counts relied on engine-specific rescue: SQLite
skip-scan (only with fresh statistics) or PostgreSQL 18's new btree skip
scan, and degenerated to partition scans everywhere else (PostgreSQL ≤ 17,
SQLite with stale statistics).

The filters now enumerate the endpoint kinds the graph declaration permits
for the counted edge kinds, expanded through the subClassOf closure — the
same set edge writes validate against — making `edges_from_idx` /
`edges_to_idx` structurally seekable on every engine and version.
Measured on PostgreSQL 18 (where the old form was already skip-scan
rescued): 0.30ms → 0.06ms per call; on older PostgreSQL the old form
could not use these indexes at all. An edge set that declares no endpoint
kinds on the required side now returns 0 without a round trip.
