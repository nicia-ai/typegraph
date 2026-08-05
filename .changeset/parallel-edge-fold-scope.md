---
"@nicia-ai/typegraph": minor
---

graph-merge: scope the edge repoint/dedupe fold to collisions repointing caused

A TypeGraph store is a multigraph: nothing enforces uniqueness on
`(from, kind, to)`, `create()` makes a parallel edge, and
`getOrCreateByEndpoints()` is the opt-in set-semantics accessor. The merge's edge
fold nevertheless grouped **every** staged edge by `(from, kind, to)` and collapsed
each group onto its lowest-sorting edge id, so a branch that created a parallel
edge lost one of the two rows — and *which* one it lost depended on how the
branch-created id happened to sort against the existing one.

The fold is now restricted to what it was designed for: a group whose members did
not all name the same endpoints before repointing, i.e. a collision the
canonicalization itself induced (`x → a` and `x → b` both becoming `x → c*`). Those
groups keep the existing min-id-survivor, property-reconciliation, and
end-of-validity behavior. Staged edges that already shared their endpoints are no
longer folded together: each distinct edge id commits as its own parallel row, and
a valid-time end lands on the row whose author claimed it rather than migrating to
an unrelated survivor.

What makes two staged edges "the same row" is their **edge id**, not equal
properties. One inherited edge staged by several branches still folds into a single
write with its property disagreements reconciled; a branch-created edge is a new
parallel row even when its properties coincide with an existing one's.

Merges that previously collapsed parallel edges will now commit both, and the
spurious `PropertyConflict` those collapses reported between two rows that were
never the same row is gone.
