---
"@nicia-ai/typegraph": patch
---

A merge reports an identity assertion id that loses the survivor rule once on `dropped`, however many branches staged it. When two branches carried the identical assertion row (the same id and validity window, as two imports of one interchange document produce) and a third candidate won the pair, such as a different branch's earlier assertion or an id the incremental target already holds, the shared id was listed on `dropped` once per branch that carried it. Both survivor reducers now skip a losing row identical to one already reported, so the report no longer depends on how many branches repeated a row.
