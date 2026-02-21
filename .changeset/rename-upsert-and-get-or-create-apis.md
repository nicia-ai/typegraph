---
"@nicia-ai/typegraph": minor
---

Add node and edge get-or-create operations with explicit API naming.

**New APIs:**

- `getOrCreateByConstraint` / `bulkGetOrCreateByConstraint` — deduplicate nodes by a named uniqueness constraint
- `getOrCreateByEndpoints` / `bulkGetOrCreateByEndpoints` — deduplicate edges by `(from, to)` with optional `matchOn` property fields
- `hardDelete` for node and edge collections
- `action: "created" | "found" | "updated" | "resurrected"` result discriminant

**Breaking changes:**

- `upsert` → `upsertById`, `bulkUpsert` → `bulkUpsertById`
- `onConflict: "skip" | "update"` → `ifExists: "return" | "update"`
- `ConstraintNotFoundError` → `NodeConstraintNotFoundError`
- Removed generic `FindOrCreate*` type exports in favor of explicit `NodeGetOrCreateByConstraint*` and `EdgeGetOrCreateByEndpoints*` types
