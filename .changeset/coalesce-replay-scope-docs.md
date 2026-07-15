---
"@nicia-ai/typegraph": patch
---

Docs: scope the `coalesceUnchangedUpserts` benefit correctly. Coalescing
eliminates _re-delivery_ churn (an already-applied change delivered again,
value-identical to the live row). It does not make a full replay-from-zero
free when the stream supersedes values in place: re-applying an older value
over the live row is a genuine change, and restoring the current value
afterwards is another, so such a replay still writes — and leaves a spurious
back-and-forth band in the live store's recorded history. Churn-free rebuilds
replay into a fresh store instead. Clarified in the option's TSDoc and in the
"Materializing external event logs" guide; no behavior change.
