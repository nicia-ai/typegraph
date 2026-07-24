---
"@nicia-ai/typegraph": patch
---

Stop reporting a reordered declaration as a schema change. Restating a kind
with its properties, enum members, or edge endpoints listed in a different
order is a semantic no-op, but the diff compared those arrays positionally and
reported the kind as `modified` — forcing callers into a privileged migration
for a schema that had not actually changed. A reordered `enum` was even
classified `breaking`, i.e. a pure reordering demanded a destructive-migration
decision.

`required`, `enum`, and edge `fromKinds` / `toKinds` are now compared as the
sets they are, in both the modified-vs-unmodified decision and the
breaking-change severity classification. Genuine changes — added or removed
properties, newly required properties, changed enum members, different edge
endpoints — are detected exactly as before.

The normalization is deliberately scoped to diff comparison and is **not**
applied to the canonical form behind `computeSchemaHash`, so no schema hash
already committed to a database changes.
