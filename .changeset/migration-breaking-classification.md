---
"@nicia-ai/typegraph": patch
---

Classify in-place property type changes and property removals as breaking schema
migrations. The migration diff previously compared only added/removed property
keys, so a changed property type (e.g. `string` → `number`) — the most common
breaking change — auto-migrated silently, leaving stored rows that no longer
satisfy the declared schema; edge property changes were unconditionally treated
as safe. Node and edge property diffs now share one classifier: a removed
property, an in-place type change, or a newly required property is breaking; a
same-type constraint change is a non-blocking warning; only added optional
properties stay safe.
