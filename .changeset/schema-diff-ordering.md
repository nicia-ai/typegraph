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

The normalization walks the document as JSON Schema rather than as plain JSON,
because a key's meaning depends on where it appears. Recursion is an
**allowlist** of known schema-valued keywords; everything else is preserved
verbatim:

- Instance data (`default`, `const`, `examples`) and unknown extension keys —
  Zod's `.meta()` merges arbitrary keys straight into the generated schema — are
  compared verbatim. Recursing into them would sort a nested key merely *named*
  `required`, silently normalizing away a real change to a stored value.
- Keys under `properties`, `patternProperties`, `dependentSchemas`, `$defs`, and
  `definitions` are user-chosen field names, not keywords, so a field *named*
  `default` still has its subschema normalized like any other.
- `dependentRequired` maps a name to a set of names, so each set is
  order-normalized.

The allowlist fails in the safe direction: an unrecognized schema-valued keyword
is left unsorted, so a reordering inside it reads as a change rather than being
hidden.
