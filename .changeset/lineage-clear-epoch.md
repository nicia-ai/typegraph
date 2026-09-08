---
"@nicia-ai/typegraph": minor
---

`Store.clear()` now rotates the graph's durable revision-origin nonce
(`typegraph_revision_origins`) in the same transaction as the rest of the clear, for every store
with `revisionTracking` or `history` enabled. Previously `clear()` reseeded (or, under `history`,
left unseeded) only the recorded clock, so a graph repopulated after `clear()` to the same
revision COUNT could mint a `base@V` token byte-identical to one minted before the clear —
origin unchanged, revision numbering coincidentally realigned — and a branch forked before the
clear would silently pass the merge precondition against a base whose entire content had been
replaced.

## Breaking

- A branch forked from a store BEFORE `Store.clear()` now correctly fails `merge()`'s `base@V`
  precondition (`BaseVersionMismatchError`) once that store has been cleared, even when the
  branch is later merged against a graph repopulated to the same revision count. This was always
  the documented intent — a cleared store is a new epoch a pre-clear branch cannot merge into —
  and is now enforced. Re-branch from the post-clear store instead of reusing one forked before
  the clear.
