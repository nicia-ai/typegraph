---
"@nicia-ai/typegraph": minor
---

Provenance support treats a required composition part as dependent on its whole, so a belief-status close reaches the parts that cannot exist without it. A fact whose kind is a `existence: "required"` part is supported only while the whole it currently hangs from is itself supported (a whole that is also a fact kind) or live (any other whole, read through `findLiveCompositionWhole` — the same owner the write path, the import assertion, and `store.verifyConstraintFences()` consult, so provenance re-spells no composition orientation of its own). Closing a whole's currency therefore closes its required parts in the same transition, transitively through a part that is itself a whole, and `RetractionReport.died` names every one of them; the affected set is widened along the same dependency so `survivedVia` and `unaffected` stay accurate. Reopening the whole reopens the parts that are otherwise supported — reopen remains support-driven, so there is no ledger of what a close closed — and a required part is closed even when a different source supports it, because the existence dependency dominates its own grounding.

An optional part is untouched: it can exist with no whole, so it keeps its attachment to the closed whole and its own belief status, and the composition claim still stops a second whole from taking it. No edge is deleted by any of this, so `store.verifyConstraintFences()`'s `compositionExistence` family reports nothing after a close — a closed required part is tombstoned, not an orphan. A graph that declares no required part pays no extra read.

### Breaking

- `retract` / `retractMany` now close the required composition parts of any whole they close, and `unRetract` / `unRetractMany` reopen the ones that regained support. A caller that relied on a closed whole keeping its required parts believed sees them tombstoned, listed in `RetractionReport.died`.
