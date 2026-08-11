---
"@nicia-ai/typegraph": minor
---

Add `store.verifyConstraintFences()`, the read-only audit of constraint violations that predate the fence.

The claim relations refuse the second live claimant of an axis from the first write after upgrade onward, but they repair nothing that is already there. A database that carried two live siblings sharing a `scope: "kindWithSubClasses"` key, an id live under both kinds of a `disjointWith` pair, or two live `cardinality: "one"` edges from one source keeps carrying them: the next write that touches such an axis is refused with the ordinary typed error naming the incumbent, and until then nothing says so. This is the diagnostic that says so.

It reads the relation each constraint is **declared over**, never a claim relation's primary key. A claim key admits one row per axis by construction, and a database written before the claim tables existed holds no edge claims at all, so a claim scan would report zero violations on precisely the data the audit exists to find. Uniqueness is read from the live `uniques` rows and folded onto the axis each row's `node_kind` belongs to — which is how a pre-upgrade duplicate sitting at two different `node_kind`s is found at all — restricted to constraint names the graph declares, so disjointness claims (whose `node_kind` is a pair label, not a kind) are audited from the nodes relation instead. Contention is counted in distinct **owner pairs** (`concrete_kind`, `node_id`), not rows, so one node legitimately holding its key at a legacy axis and at the current one is not reported.

Each entry names the claim row two claimants contend for — built by the same functions the fence writes with — plus the conflicting `owners` (uniqueness, disjointness) or `edgeIds` (cardinality). It writes nothing and repairs nothing: choosing which claimant keeps an axis is a data-loss decision that belongs to the operator.

- **`GraphBackend` gains an optional `readConstraintFenceViolations`.** Additive; both bundled dialects implement it through one shared statement per family. `store.verifyConstraintFences()` refuses with `ConfigurationError` / `CONSTRAINT_FENCE_AUDIT_UNSUPPORTED` on a backend without it, rather than returning an empty report a caller would read as "clean".
- **`KindRegistry` gains `disjointKindPairs()`**, the declared pairs as kind pairs — the inverse of the internal pair label, so an enumerating caller never spells the label's form itself.

The parity matrix in `backend-setup.md` gains the three rows this mechanism owes a reader: the `constraintClaims` capability, PostgreSQL's `40001` in place of the typed error above READ COMMITTED, and the claim row's lock being held to end-of-transaction on both dialects — refusal included, so a caller that catches a constraint error and continues blocks other writers of that axis for the rest of its transaction.
