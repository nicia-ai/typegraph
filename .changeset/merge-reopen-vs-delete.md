---
"@nicia-ai/typegraph": patch
---

A graph merge no longer silently drops a reopened validity window when another branch deletes the same node or edge. Reopening a row's ended window (`update(id, props, { clearValidTo: true })`) asserts the fact is true again, the opposite of a deletion, so it now counts as a modification for delete/modify purposes: the merge records a `DeleteModifyConflict` naming the deleting and reopening branches, and `onDeleteModifyConflict` decides the row. Under `"flag"` (the default) and `"modifyWins"` the row survives and is reopened, reported in `validityEnds`; under `"deleteWins"` it is deleted and listed in `dropped`. On an incremental merge the committed target's own reopen or deletion takes precedence over a branch's, as a target properties edit does. Ending a row is unchanged: a concurrent deletion still absorbs it with no conflict.

A reopen of an ended composition attachment that another branch's deletion takes one end from is still refused with `MergeCompositionOrphanError` when the reopen itself is not written because the incremental target's end for the row, or a sibling branch's end, takes precedence over it.
