---
"@nicia-ai/typegraph": minor
---

Graph Merge now keeps the **inherited** edge when a repoint-induced collapse folds a
committed row together with a branch-created one, instead of keeping the
lexicographically-minimal edge id.

Previously the survivor of such a collapse was whichever edge id sorted lowest. A
collapse rewrites the row it keeps and ends none of the rows folded into it, so when a
branch-created id sorted below the committed one, the merge wrote the branch's row as a
new edge and left the committed edge live beside it at its pre-merge properties — two
live rows for one folded relationship, the edit staged for the committed row never
written, and `merged.edges` counting one of them. Which of the two you got depended on
an id sort, so it was not behavior a caller could depend on.

The surviving edge id reported in `PropertyConflict.entityId`, window resolutions and
provenance is consequently the inherited row's id whenever the collapse involved one.
That is the id of the row that actually persists, and it no longer moves with
branch-created id lexicographics. Collapses among branch-created edges alone are
unchanged, as is the property/window reconciliation applied to the survivor.
