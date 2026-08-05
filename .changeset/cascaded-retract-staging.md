---
"@nicia-ai/typegraph": minor
---

graph-merge: stage cascade retractions with their cause instead of inferring intent

A node soft-delete ends every open identity assertion touching the node, so a
branch that deletes a node stages retractions it never asked for. The merge
previously separated those cascade endings from a branch's own retraction with
a conservative branch-level heuristic, which deliberately over-dropped the
same-branch case: a branch that retracted an assertion and LATER deleted one of
its endpoints looked exactly like a pure cascade, so its retraction was dropped
whenever the deletion was overruled — silently keeping truth the branch had
explicitly ended.

The soft-delete cascade now ends assertions at the deleted node's own
`deleted_at`, which makes the cause derivable: the state-diff compares each
retracted assertion's end instant to the deletion instants of its endpoints and
stages the retraction as either a cascade naming the deleted node or the
branch's own act. The merge planner drops a retraction only when EVERY branch
staged it as the cascade of a deletion that delete/modify resolution then
overruled, so an explicit retraction survives even when it comes from the
deleting branch. Two cases stay conservative because nothing distinguishes them
at the stored resolution — a hard delete (which removes the assertion rows) and
a retraction issued in the same millisecond as the delete that followed it.
