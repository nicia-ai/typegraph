---
"@nicia-ai/typegraph": minor
---

Add optional `annotations` field to `defineNode` and `defineEdge` for consumer-owned per-kind structured data — UI hints, audit policy, provenance pointers, and other tooling labels that don't belong in the Zod schema.

```typescript
const Incident = defineNode("Incident", {
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    occurredAt: z.string().datetime(),
  }),
  annotations: {
    ui: {
      titleField: "title",
      temporalField: "occurredAt",
      icon: "alert-triangle",
    },
    audit: {
      pii: false,
      retentionDays: 365,
    },
  },
});

const reportedBy = defineEdge("reportedBy", {
  annotations: {
    ui: { showInTimeline: true },
  },
});
```

**Contract:**

- TypeGraph stores and versions `annotations` but never reads, validates, or interprets keys inside the field. Consumers own the entire namespace — no reserved prefixes, no `x-typegraph` extension convention. Future library-owned per-kind state, if needed, will use a separate sibling field rather than carving out keys here.
- Annotations are included in `SerializedSchema.{nodes,edges}[*].annotations` and contribute to schema hashing with stable sorted-key ordering. Changes surface as `safe`-severity diffs through `getSchemaChanges()` / `SchemaManager`, so reformatting the annotations object doesn't bump the version, but value or structure changes do.
- Graphs that never set `annotations` produce identical canonical-form hashes to today — adoption requires no migration. An explicit empty object (`{}`) is a structural opt-in and bumps the hash.
- Values must be JSON-serializable. The `KindAnnotations` type is `Readonly<Record<string, JsonValue>>`, and at runtime `defineNode` / `defineEdge` reject `bigint`, `function`, `symbol`, `undefined`, `Date`, and other class instances with a `ConfigurationError` — so accidentally-non-JSON annotations can never silently break hashing or storage round-trips.

Closes #102.
