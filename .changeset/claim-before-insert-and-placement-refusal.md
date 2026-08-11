---
"@nicia-ai/typegraph": minor
---

Issue a node's claims on the side of the row write their placement names, and refuse the writes a backend with no transactions cannot undo.

A uniqueness claim whose axis spans kinds beyond the writer's own is the **only** fence for that axis — the nodes primary key is `(graph_id, kind, id)`, so an `Employee`'s insert does not collide with a `Contractor`'s — and a fence issued after the write it fences is not a fence. Those claims now precede the row insert they gate, with the reservations given back if that insert does not land, so a refusal leaves zero net effect. On the import path this is what turns a violation into a refusal instead of a committed row: `importGraph` recovers per row and takes no per-graph lock, so a claim written after the row it was supposed to refuse let the row commit.

A claim whose axis **is** the writer's own kind keeps the position it has today, after the row: the uniques primary key at that axis is already the complete fence for it, moving it would buy nothing, and it would cost a refusal on backends with no transactions. Placement is decided once, per claim, from the one fact both readings turn on — does this claim's axis span kinds beyond the writer's own? — and carried as data through the entry, the claim seam, the refusal and the lock projection. Which writes take the per-graph advisory lock, and the reason each reports, are unchanged.

Two new refusals follow, both on `transactions: false` backends (Cloudflare D1, `drizzle-orm/neon-http`, `transactionMode: "none"` SQLite), and both `ConfigurationError` / `CONSTRAINT_WRITE_FENCE_UNSUPPORTED`:

- **`importGraph` / `importGraphStream` into a graph any of whose node kinds declares a unique constraint of any scope, or any of whose edge kinds is non-`many`.** Import writes claim rows like every other writer but is not covered by the write-transaction refusal, so it would have written reservations with nothing to roll them back. The refusal is computed up front, before the first chunk, so a streamed import cannot commit *k-1* chunks and then fail. Disjointness owes no claim yet — that fence lands in a later batch — so a disjoint-only graph is not refused here.
- **A node UPDATE or RESURRECT whose kind declares only `scope: "kind"` unique constraints**, reason `nodeUniquenessClaim`. This closes an existing hole rather than paying for a new one: the transition seam already claims before its gated row write for every scope, so that path already wrote a reservation with nothing to undo it. The matching **create** is not refused — its claim stays after the row — which is the pair that makes the rule legible: same kind, same constraint, opposite verdicts, decided only by placement.

`ConstraintFenceReason` gains `nodeUniquenessClaim` for that refusal. It is never returned by the lock projection, so it cannot widen the set of writes that take the per-graph lock.

Claim statements within each placement group are issued in one canonical order — code-point on `(relation, graph, axis, constraint, key)` — and the pre-insert group is always issued first, so two writers touching the same claim rows for one row acquire them in the same order instead of deadlocking. For a node create this is observable as statement order: a kind owing only own-axis claims emits exactly what it emits today, a kind owing a cross-kind claim emits it ahead of the row insert, and a kind owing both emits two claim statements, one on each side.
