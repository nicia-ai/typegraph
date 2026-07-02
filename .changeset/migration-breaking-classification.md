---
"@nicia-ai/typegraph": patch
---

Classify incompatible property-schema changes as breaking schema migrations. The
migration diff previously compared only the top-level JSON-Schema token of each
property, so a changed property type (e.g. `string` → `number`), a changed array
item type (`string[]` → `number[]`), a narrowed enum, or a type change nested
inside an object all auto-migrated silently as a non-blocking warning, leaving
stored rows that no longer satisfy the declared schema; edge property changes
were unconditionally treated as safe. Node and edge property diffs now share one
recursive, conservative classifier: a change is `safe` only when it can be proven
non-breaking (a new optional property, a metadata-only edit, or an additive
optional field nested inside an object). Everything else — a removed property, a
newly required property, an in-place type change, a changed array item schema, an
enum/const/composition change, a same-type constraint change, or a breaking
change nested inside an object — is `breaking` and blocks auto-migration. The
`warning` severity is no longer emitted for property changes.
