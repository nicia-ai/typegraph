---
"@nicia-ai/typegraph": minor
---

`orderBy(alias, field)` now takes typed field names. `field` is a property the alias's kind declares, `"id"`, `"kind"`, a metadata field by its path in a selected row (`"meta.createdAt"`, `"meta.updatedAt"`, `"meta.validFrom"`, `"meta.validTo"`, `"meta.deletedAt"`, and on a node alias `"meta.version"`), or on an edge alias `"fromId"` / `"toId"`. Any other name is a compile error and a `ConfigurationError` at runtime. Before this release an unknown name was read as a property and the query silently sorted by NULL. That covered every camelCase timestamp such as `orderBy("u", "createdAt")` on a kind that declares no `createdAt`, which several documentation pages showed.

System fields are named by where a full select returns them, so `orderBy("p", "meta.createdAt")` sorts by `row.meta.createdAt`. Because metadata lives under the reserved `meta.` prefix, a declared property never collides with it. A kind that declares its own `createdAt` is ordered by that property with `"createdAt"` and by the system timestamp with `"meta.createdAt"`. The old rule, under which a declared property with a snake_case system name shadowed the system column, is gone. Node `meta.version` becomes orderable, including with `paginate()` and `stream()`.

`orderByFragment(alias, field)` is typed against every node and edge kind of the graph, since a fragment does not know which kind its alias will be bound to; the alias is checked when the fragment is applied.

### Breaking

The snake_case system names are removed, with no alias. A caller the type checker does not reach gets a `ConfigurationError` (`details.code: "ORDER_FIELD_RENAMED"`) whose message and `details.replacement` name the new spelling.

| Removed | Use |
| --- | --- |
| `"created_at"` | `"meta.createdAt"` |
| `"updated_at"` | `"meta.updatedAt"` |
| `"valid_from"` | `"meta.validFrom"` |
| `"valid_to"` | `"meta.validTo"` |
| `"deleted_at"` | `"meta.deletedAt"` |
| `"from_id"` (edge alias) | `"fromId"` |
| `"to_id"` (edge alias) | `"toId"` |

- Changed: an `orderBy(alias, field)` name that is neither a declared property nor a system field throws `ConfigurationError` (`details.code: "ORDER_FIELD_UNKNOWN"`) instead of sorting by NULL. An alias that is not part of the query throws `ConfigurationError` (`details.code: "ORDER_ALIAS_UNKNOWN"`).
- Changed: a property declared under a removed snake_case name, such as `created_at`, is now always ordered as that property. Order by the system column with its `meta.` name.
- Changed: `orderByFragment`'s `field` parameter is typed as `GraphOrderField<G>` instead of `string`.
- Unchanged: the expression form `orderBy((ctx) => ...)`, aggregate `orderBy(key)`, and `neighbors()`' `orderBy`.
