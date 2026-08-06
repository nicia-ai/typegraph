---
"@nicia-ai/typegraph": minor
---

graph-merge: judge the edge fold's property union against base, and report a
target-precedence window discard

Two adjacent gaps in the edge repoint/window path. One is a bug fix, the other
adds an optional field to a report type, so this ships at the higher `minor`
bump and covers both.

The repoint fold's property union had no base to compare against, unlike the
node path's three-way merge, so a staged copy of an INHERITED edge contributed
its whole fork property bag as first-class `(branch, value)` claims — including
the values it never touched. Under any rank-based `onPropertyConflict` an
untouched base value could therefore outvote a value a branch actually authored,
decided by whichever branch label happened to ride on the untouched copy. The
window-only carrier made it observable: an inherited row whose only change is
its end-of-validity is staged solely to give that ending somewhere to ride, its
properties ARE the base's, and its branch is merely whichever sorted first in
staging. The union now filters every contributor to the properties it CHANGED
from its own base — a branch-created edge has no base, so everything it carries
stays a full claim — which means a carrier contributes no claim and raises no
conflict at any rank. Genuine disagreements are unaffected: two members that
changed one property differently still conflict, over their real values alone.

`MergeReport.validityEnds` now also reports the window claims that target
precedence discards. When the incremental target had already moved an inherited
row's end, the reconciler took the row out of the resolution and the branch
claims vanished from the report entirely — less visible than a claim that merely
lost the least-claim rule, which stays named in `claimedBy`. Such a row now gets
a resolution naming the target's own committed instant, its discarded claimants,
and the new optional `ValidityEndResolution.precedence` field set to the
exported `VALIDITY_END_TARGET_PRECEDENCE`. The field is absent on every entry
the merge itself decided, so existing consumers read what they always read; no
write is staged and no provenance credit is minted for such a row, and a row no
branch claimed still produces no entry at all.
