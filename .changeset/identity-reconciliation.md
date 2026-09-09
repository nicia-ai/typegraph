---
"@nicia-ai/typegraph": minor
---

Identity-aware Reconciliation. An identity-enabled graph with history capture
now retains a replayable identity history: `store.identity.transitionsOf(ref)`
returns every transition that changed a node's identity class — assertions,
retractions, same-id folds, deletes and restores, validity-window ends, kind
drops, schema transitions and reconciliation decisions — each carrying the
assertion ids involved, both temporal coordinates, and, for a decision made by
a merge, the policy arm, branch, branch ancestry and plan and review digests
that produced it. `store.identity.replay(ref)` pairs each transition with the
class membership before and after it, reconstructed through the same
historical reader `asOf` and `asOfRecorded` reads already use, so replay can
never disagree with a live read. `pruneIdentityTransitions(store, { beforeRecorded })`
trims retained explanations and records a watermark that replay reports rather
than hiding, and archival interchange carries a `transitions` section plus the
retention watermark, bumping the interchange format to `3.0` (older documents
still import and validate unchanged). Restoring an archive's transitions
validates shape only and never re-derives membership; it sets the restored
graph's own watermark so replay reports the pre-restore range honestly instead
of claiming a complete history it cannot reconstruct.

Graph merge gains identity reconciliation under a new `identity` merge-options
bag: `pairing` lets an explicit `same` assertion propose or force a candidate
match between nodes created under different ids, a class-lifted `different`
assertion now vetoes a match at plan time instead of aborting at commit,
`onAssertionConflict` makes retract/reassert races and independently duplicated
assertions resolvable by policy instead of only refusable, and
`onProvenanceConflict` states how contradictory branch attribution across a
fused cluster is handled. Every unresolved case is reported as a typed
`IdentityUnresolvedConflict` on the merge report and inside the durable plan,
and the policy bag is part of the review digest, so a plan cannot be applied
under policies its reviewer did not approve. Defaults preserve current
behavior exactly: `pairing: "off"`, `onAssertionConflict: "refuse"`, and
`onProvenanceConflict: "keepBoth"`.

One narrow, deliberate behavior change ships under the default policy: when
two branches end the same base identity assertion at different valid-time
instants, the merge now commits the earliest staged `validTo` rather than
whichever branch happened to be staged last. The new rule is deterministic and
branch-order-independent — an improvement — but it is a real change to which
instant a default-policy merge commits, not a byte-for-byte carry-over of
prior behavior.

Replay requires `history: true` and refuses with
`IDENTITY_REPLAY_REQUIRES_HISTORY` otherwise; Cloudflare D1 and neon-http
continue to refuse identity-enabled graphs outright.

A transaction receipt's `writes.identity` gains `transitions`, counted beside
(never inside) `total`: the number of identity transition-log notes the
transaction's flush wrote, an annotation of the assertion/retraction writes
`total` already counts rather than a fourth kind of write.
