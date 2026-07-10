---
"@nicia-ai/typegraph": patch
---

Fix: `store.algorithms.degree()` undercounted edges written before an endpoint
declaration changed.

To let the composite edge indexes seek — both lead with the endpoint kind
column, so a bare `from_id = ?` cannot — the direction filter supplied the
missing kind equality by enumerating the endpoint kinds the *graph declaration*
permits for the counted edge kinds. That enumeration is complete only for rows
written under the current declaration. Narrow `knows` from `from: [Person]` to
`from: [Employee]`, and every `Person`-rooted `knows` edge already on disk drops
out of the filter: `degree()` silently returns a number too small, with no error
and no warning.

The filter now derives the kind from the counted node itself, via an
uncorrelated scalar subquery. This is exact by construction: an edge row stores
the *actual* kind of each endpoint node (the write path copies it off the
endpoint reference) and a node's kind is immutable for the life of its id, so
for any edge incident to a node, the endpoint kind on that node's side is that
node's kind and nothing else — however the declaration later evolves.

It is also a better filter. An equality on one kind replaces an `IN` list over
every declared endpoint and its `subClassOf` descendants, and both engines hoist
the uncorrelated subquery to a constant (a Postgres InitPlan, a SQLite one-shot
scalar subquery), so the seek is unchanged. `EXPLAIN QUERY PLAN` still shows
`typegraph_edges_from_idx` / `_to_idx` seeks with no partition scan.

`degree()` of an id that names no node is `0`, as before.
