---
"@nicia-ai/typegraph": patch
---

A graph merge no longer refuses a branch that deletes an edge and then the edge's `restrict` endpoint, the order `onDelete: "restrict"` (the default) forces on the branch itself. Merge apply deletes nodes before edges, and each node delete used to count the plan's own edge deletions as live edges, so the merge failed with `MergeConstraintConflictError` caused by `RESTRICTED_DELETE` even though the plan removed the blocking edge. The plan's edge deletions are now consumed by the node deletes that precede them, through `merge()`, `mergeIncremental()`, `applyMergePlan()`, `applyMergePlanInTransaction()` and `applyDurableMergePlan()`. A `restrict` edge the plan does not delete still refuses the merge.
