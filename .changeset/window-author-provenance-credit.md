---
"@nicia-ai/typegraph": patch
---

graph-merge: credit the branch that authored a merged row's end-of-validity

Ending a row's validity is authored state, but a branch whose only change to a
row was its window could contribute the instant the merge committed and still be
absent from the merge's provenance. An identity is staged once, so a branch that
merely moved an inherited edge's window had its staged copy skipped whenever
another branch's property edit already staged that edge — and the provenance for
edges is derived from the staged copies. Nodes were worse: a window change had no
provenance path at all, so a window-only node ending was credited to nobody even
when no other branch touched the row.

The credit now comes from the window resolution itself, which is the only phase
that knows whose claim was committed. It credits exactly the branches whose claim
IS the resolved end — a claim that lost the least-claim rule contributed nothing
to the committed row, and remains visible in `MergeReport.validityEnds` under
`claimedBy`. A branch that both edited a row's properties and moved its window
stays one contribution.

The staged copy that carries a window-only ending is no longer credited for
carrying it: that copy exists only to give the ending a row to write, its
properties are the base's, and the branch holding it is whichever sorted first —
possibly one whose claim the merge discarded. Which branch carries the row is
left exactly as it was, because that branch also labels the base's properties in
the repoint fold's property union, where a relabelled contribution can change
which value a fold commits. Merge outcomes are unchanged; only the provenance is.
