---
"@nicia-ai/typegraph": minor
---

`Store.clear()` now rotates the graph's durable revision-origin nonce
(`typegraph_revision_origins`) in the same transaction as the rest of the clear, for every store
able to mint either origin-namespaced `base@V` anchor form — a store with `revisionTracking` or
`history` enabled (the TypeGraph revision anchor), AND an engine-anchored store whose backend
declares `lineage` directly with tracking off (the engine anchor). Previously `clear()` reseeded
(or, under `history`, left unseeded) only the recorded clock and left an engine-anchored store's
origin untouched entirely, so a graph repopulated after `clear()` to look the same — the same
revision COUNT for a tracked store, or a coincidentally-matching engine revision for an
engine-anchored one — could mint a `base@V` token byte-identical to one minted before the clear,
and a branch forked before the clear would silently pass the merge precondition against a base
whose entire content had been replaced.

`computeBaseVersion` and `Store.revisionOriginNow()` also now read that origin row fresh on every
call instead of caching it per `Store` instance. Two live `Store` objects can legitimately observe
the same graph, and only one of them runs `clear()` at a time; the removed cache previously let the
OTHER instance keep minting anchors from its pre-clear origin until it happened to be recreated,
so every merge into it failed at commit for no reason visible to the caller.

## Breaking

- A branch forked from a store BEFORE `Store.clear()` now correctly fails `merge()`'s `base@V`
  precondition (`BaseVersionMismatchError`) once that store has been cleared, even when the
  branch is later merged against a graph repopulated to look the same — for a revision-tracked
  store, the same revision count; for an engine-anchored store, a coincidentally-matching engine
  revision. This was always the documented intent — a cleared store is a new epoch a pre-clear
  branch cannot merge into — and is now enforced for BOTH anchor forms. Re-branch from the
  post-clear store instead of reusing one forked before the clear.
