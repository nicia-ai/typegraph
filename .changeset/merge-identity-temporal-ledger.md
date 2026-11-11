---
"@nicia-ai/typegraph": minor
---

A graph merge now plans its identity changes against the same temporal ledger its commit validates them against, so a contradiction with the target's history is refused at plan time, typed, instead of being committed or failing inside the commit.

- A base assertion a branch retracts is judged as the history it becomes, valid until the retraction's end. A merge could previously commit a ledger that held two nodes both the same and different over that span — for example one branch asserting `different(b, c)` while another asserted a backdated `same(a, c)` and retracted the inherited `same(a, b)` — and `validateIdentity()` did not report it. That merge is now refused with `GRAPH_MERGE_IDENTITY_CONFLICT`.
- A branch claim that contradicts a row the target had already ended — which a branch does not carry, so the branch accepted the claim — or a node the merge deletes, whose ended history the deletion keeps and whose rows the plan does not retract hold until the merge, used to pass `planMerge()` and then fail inside the commit. `planMerge()`, `planMergeIncremental()` and every merge entry point now refuse it before any write with `GRAPH_MERGE_IDENTITY_CONFLICT`; the error's details name the `different` assertion, the class it falls inside and the overlapping `window`.
- A branch that deletes a node ends the node's assertions on the target when the branch deleted it, as a retraction does, instead of at the merge. A branch that deleted a node and then asserted a pair the node's assertions had separated now merges; it was refused, and since the plan did not foresee it, it failed inside the commit. An assertion over the deleted node that the plan does not retract still ends at the merge.
- An incremental merge whose target commits and ends such a row between planning and the commit is refused with `BaseVersionMismatchError`, to be re-planned, rather than by the commit's identity importer.
- A branch assertion the importer would refuse for its shape, such as one valid from after the planner's clock, is refused at plan time with `IdentityMergeConflictError` (the importer's code in `details.identityCode`) rather than a generic `MergeError`.
- A refusal that still reaches the commit's identity importer no longer suggests retrying: reaching it means planning did not foresee the refusal, and re-planning against an unchanged target refuses again.

### Breaking

- A merge that deletes a node ends the node's identity assertions at the instant the branch deleted it rather than at the merge, as a branch's retraction already did, so an `asOf` read of the target between the two instants no longer sees them. A merge in which the deleting branch then asserted a relation those assertions contradicted, previously refused with `GRAPH_MERGE_IDENTITY_CONFLICT`, now succeeds.
