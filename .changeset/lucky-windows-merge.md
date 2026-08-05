---
"@nicia-ai/typegraph": minor
---

Merge an inherited row's end-of-validity instead of discarding it

`update(id, {}, { validTo })` on a branch is an ordinary write, but the merge
silently dropped it: modification detection compared properties only, so a
branch that ended an inherited node's or edge's validity merged as a no-op.
There was no workaround preserving row identity and history — deleting the row
was the only statement the merge honored, and it is a strictly stronger one.

An end-of-validity is now treated as a **sibling of deletion**:

- one branch ends a row → that end is committed, including a *later* end that
  extends the window;
- several branches end it differently → no conflict; the **earliest** end wins
  (a fixed, commutative rule, so the merge stays order-independent);
- `mergeIncremental()`'s target already ended it → the target's end stands, the
  same committed-target precedence identity survivors already get;
- one branch ends it and another deletes it → deleted, with **no**
  `DeleteModifyConflict` — the stronger statement absorbs the weaker one;
- a branch re-states the end the target holds → still coalesces under
  `coalesceUnchangedUpserts`: no version bump, no history row.

`MergeReport` gains `validityEnds`, listing every row whose end the merge
changed and the branches that claimed it — the arbitration is silent by design,
so this is how a caller sees it happened. Window deltas the commit cannot apply
to a live row (a fork `validFrom` divergence, or a `validTo` cleared back to
open — both reachable only by soft-delete + resurrect inside a fork) are now
reported in `dropped` with reason `"window-not-applicable"` instead of being
ignored.

**Behavior change.** Merges where a branch ended an inherited row now write that
end, so new version bumps, history rows, and recorded-time entries appear where
a no-op used to be. There is no opt-out flag: a permanent knob for "does the
merge lose data" is worse than this note. Nothing that previously succeeded now
fails.

Also fixes a cross-backend hazard in `coalesceUnchangedUpserts`: the requested
and stored valid-time bounds are now compared as instants rather than as raw
driver text, so the same upsert no longer coalesces on SQLite while writing on
PostgreSQL.
