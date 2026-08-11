---
"@nicia-ai/typegraph": minor
---

Fence `disjointWith` with a claim on the declared pair, and enforce it under `importGraph`.

Disjointness was probed and never fenced. The nodes primary key is `(graph_id, kind, id)`, so `Person "X"` and `Company "X"` are two different rows by construction — the exact collision the axiom forbids is the one the database cannot refuse — and the probe was only as good as the serialization around it. `importGraph` takes no per-graph lock and, until now, ran no disjointness probe at all: an import could commit both halves of a violating pair.

A create of a kind with a `disjointWith` partner now reserves one claim row per partner, in the same relation uniqueness claims use, at the pair's own axis with the node's id as the key. Both kinds of a pair fold to one axis through the registry's own canonical pair label, so their claims contend for one row and its primary key refuses the second writer. The claim precedes the row it gates and is given back if that row does not land, so a refusal leaves zero net effect. Because the two families arrive through one list of claim sites, every path that already maintained uniqueness reservations — create, batch create, delete, import — maintains disjointness reservations too. A **resurrect** — a soft-deleted node revived by `.create()` on its tombstoned id, `upsertById`, `upsertByIdFromRecord`, `bulkUpsertById`, or `getOrCreateByConstraint` — reserves the same claim, since reviving a tombstone re-introduces a live id under a kind exactly as a create does; the resurrect leg no longer has a window where it could revive a node under an id a disjoint partner already holds live.

`importGraph` gains the per-row disjointness probe both node paths were missing, and the per-row recovery it sits in is widened from `UniquenessError` to every declared-constraint refusal. Behavior deltas:

- **Import now enforces disjointness.** A payload containing a `Person` and a `Company` with the same id, in one batch or in sequence, refuses the second **row** and reports it in `errors` while the import continues — the accepted rows commit. Previously both committed silently. A *concurrent* violation, taken by another writer between this row's probe and the batch's claim, still surfaces from the claim and aborts the import; that asymmetry is what import already does for uniqueness.
- **`importGraph` / `importGraphStream` is refused on a `transactions: false` backend when any node kind has a disjoint partner**, joining the unique-constraint and non-`many`-cardinality cases (`ConfigurationError` / `CONSTRAINT_WRITE_FENCE_UNSUPPORTED`). A disjoint create's claim precedes its row, and without a transaction a failure between the two would leave a reservation with no repair path.
- **A kind or unique constraint name containing `U+001E` is refused at `defineNode` / `defineGraph`.** That code point builds the axes that are not kinds, so a name carrying it could spell the reserved disjointness axis. New refusal on an input no real schema carries.

The refusal a caller sees is the family's own `DisjointError`, with the same payload whichever layer produced it: the probe reads the partner's node row, the claim reads its reservation's owner, and both name the holder's concrete kind.
