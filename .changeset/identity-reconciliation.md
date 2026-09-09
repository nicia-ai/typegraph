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
that produced it. A transition an archival restore brought in carries
`restored.at`, the destination's wall clock at restore time, so an audit view
can tell an imported explanation from a locally replayable event. That marker
is a wall clock rather than a `RecordedInstant` on purpose: a restore records
history, it does not relive it, so it never advances the destination's
recorded-revision counter and there is no revision on the destination's own
axis to pair the timestamp with — the retention watermark
(`truncatedBefore`) remains the only revision-shaped signal a restore
leaves behind.
`transitionsOf` and `replay` both page: `limit` caps the number of boundaries
one page returns and a capped page hands back a `nextFrom` cursor to pass as
the next call's `fromRecorded`. Bounding the answer with
`fromRecorded`/`toRecorded` never bounds the lineage search — discovery walks
the whole log, because the note naming an earlier class canonical routinely
sits above the requested window. `store.identity.replay(ref)` pairs each transition with the
class membership before and after it, reconstructed through the same
historical reader `asOf` and `asOfRecorded` reads already use, so replay can
never disagree with a live read. `pruneIdentityTransitions(store, { beforeRecorded })`
trims retained explanations and records a watermark that replay reports rather
than hiding, and archival interchange carries a `transitions` section plus the
retention watermark, bumping the interchange format to `3.0` (older documents
still import and validate unchanged). Restoring an archive's transitions
validates shape only and never re-derives membership; every restored row is
marked as such so `replay` never pairs it with a fabricated before/after, and
— when the destination has no identity transitions of its own yet — the
restore also sets its own watermark so `replay` reports the pre-restore range
honestly instead of claiming a complete history it cannot reconstruct.

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

### Breaking changes

- `store.identity.transitionsOf` returns `{ transitions, nextFrom? }` rather
  than a bare array, so a capped page can carry its continuation cursor.
  Destructure the result (`const { transitions } = await
  store.identity.transitionsOf(ref)`).
- `IDENTITY_REPLAY_LIMIT_EXCEEDED` is gone from `IdentityReplayErrorDetails`
  and the error catalog. A lineage with more boundaries than `limit` now
  pages: `replay` and `transitionsOf` return a `nextFrom` recorded instant
  naming the first boundary the page stopped short of. Code that caught the
  refusal and resumed from `details.resumeFromRecorded` reads `nextFrom` off
  the successful result instead.
- Lineage discovery no longer honors `fromRecorded`/`toRecorded`: the walk
  reads the whole transition log and the window is applied to the converged
  result, so a window can never hide the notes that name an earlier class
  canonical. Two consequences: a narrow-window audit read now scans the full
  lineage on every call, and `IDENTITY_REPLAY_WALK_INCOMPLETE`'s only remedy
  is `pruneIdentityTransitions` — narrowing the window no longer lowers the
  walk's read volume, and the error's suggestion says so.

- The identity transition log adds two relations, `typegraph_identity_transitions`
  and `typegraph_identity_transition_retention`, which `ensureSchema` creates on
  an identity-enabled graph. `createSqlSchema` accepts `identityTransitions` and
  `identityTransitionRetention` as optional overrides alongside the existing
  table names; a deployment whose migration tooling enumerates TypeGraph's
  relations, or whose database role has restricted DDL, must account for both
  before upgrading.
- Restoring an archival export (`identityMode: "archival"`) whose source graph
  retains identity transitions or has ever pruned them now requires the
  restore target to be opened with `history: true`. `importGraph` and
  `importGraphStream` refuse such a document with
  `IDENTITY_REPLAY_REQUIRES_HISTORY` before writing anything, where they
  previously wrote the rest of the document successfully because no
  transitions section existed to carry the transitions in the first place.
  Open the restore target with `history: true` to keep a backup/restore
  pipeline that moves data out of a history-enabled graph working.
