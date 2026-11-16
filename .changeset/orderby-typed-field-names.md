---
"@nicia-ai/typegraph": minor
---

`orderBy(alias, field)` now takes typed field names. `field` is a property the alias's kind declares, `"id"`, `"kind"`, a metadata field by its path in a selected row (`"meta.createdAt"`, `"meta.updatedAt"`, `"meta.validFrom"`, `"meta.validTo"`, `"meta.deletedAt"`, and on a node alias `"meta.version"`), or on an edge alias `"fromId"` / `"toId"`. On a kind whose property set is closed (`z.object`, `z.strictObject`, including objects wrapped by `.refine()` / `.superRefine()` or built with `.extend()`), any other name is a compile error and a `ConfigurationError` at runtime. Before this release an unknown name was read as a property and the query silently sorted by NULL. A kind whose schema admits unknown keys (`z.looseObject`, `.passthrough()`, `.catchall()`) can store keys it does not declare, so it still orders by any name as a property, as before, and its field type is `string`. That covered every camelCase timestamp such as `orderBy("u", "createdAt")` on a kind that declares no `createdAt`, which several documentation pages showed.

System fields are named by where a full select returns them, so `orderBy("p", "meta.createdAt")` sorts by `row.meta.createdAt`. Because metadata lives under the reserved `meta.` prefix, a declared property never collides with it. A kind that declares its own `createdAt` is ordered by that property with `"createdAt"` and by the system timestamp with `"meta.createdAt"`. In 0.74, a snake_case name such as `"created_at"` named the system column unless the kind declared a property of that name, in which case the property took precedence. In this release a snake_case name never names the system column: a declared `created_at` is ordered as that property, as before, and the system column is reached only as `"meta.createdAt"`. Node `meta.version` becomes orderable, including with `paginate()` and `stream()`.

`orderByFragment(alias, field)` is typed against every node and edge kind of the graph, since a fragment does not know which kind its alias will be bound to; the alias is checked when the fragment is applied.

### Breaking

The snake_case system names are removed, with no alias. A caller the type checker does not reach gets a `ConfigurationError` (`details.code: "ORDER_FIELD_RENAMED"`) whose message and `details.replacement` name the new spelling. This applies on open schemas too, unless the kind declares a property of that name, so that a query written against the previous release can never silently switch from the system column to an undeclared property.

| Removed | Use |
| --- | --- |
| `"created_at"` | `"meta.createdAt"` |
| `"updated_at"` | `"meta.updatedAt"` |
| `"valid_from"` | `"meta.validFrom"` |
| `"valid_to"` | `"meta.validTo"` |
| `"deleted_at"` | `"meta.deletedAt"` |
| `"from_id"` (edge alias) | `"fromId"` |
| `"to_id"` (edge alias) | `"toId"` |

- Changed: on a closed schema, an `orderBy(alias, field)` name that is neither a declared property nor a system field throws `ConfigurationError` (`details.code: "ORDER_FIELD_UNKNOWN"`) instead of sorting by NULL. An undeclared `"version"` is refused this way and pointed at `"meta.version"`; it was never a system order name, so on an open schema it is still a property. An alias that is not part of the query throws `ConfigurationError` (`details.code: "ORDER_ALIAS_UNKNOWN"`).
- Changed, deliberately: a key stored outside a closed schema can no longer be ordered by in the alias form. Such keys come from an `importGraph` with `onUnknownProperty: "allow"`, or from a property later removed from the schema. Declare the key in the schema, optionally (`z.string().optional()`), to order by it.
- Changed: `orderByFragment`'s `field` parameter is typed as `GraphOrderField<G>` instead of `string`.
- Unchanged: the expression form `orderBy((ctx) => ...)` and aggregate `orderBy(key)`.
- Known inconsistency: `store.neighbors()`' `orderBy: { field }` still takes the bare edge metadata names (`"createdAt"`, `"validFrom"`, …), not the `meta.` names. It will move to the `meta.` names in a later release; this release leaves it unchanged.
