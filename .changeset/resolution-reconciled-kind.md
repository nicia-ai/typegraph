---
"@nicia-ai/typegraph": patch
---

A durable merge plan built under `reconcileTypes: "ontology"` no longer fails its own artifact validation ("A resolution must name its complete guarded cluster and carry exactly N-1 decisive edges") when a retype cluster spans several ids. The resolution the merge report and the plan artifact carry for such a cluster now names the kind the canonical row is written under — the reconciled kind `TypeReconciliation.toType` records — instead of the staged survivor's pre-retype kind, which is the value the artifact's resolution-evidence check, the commit's node write and `guards.retypes` already agree on.

### Breaking changes

- `EntityResolution.kind` (on `MergeReport.resolutions` and a plan artifact's `review.resolutions`) names the reconciled kind for a cluster the ontology cascade retypes. Code that joined a resolution to its staged members by the survivor's pre-retype kind should read `TypeReconciliation.fromTypes` for the staged kinds; clusters no retype touches are unchanged.
