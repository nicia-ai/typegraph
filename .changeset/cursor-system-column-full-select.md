---
"@nicia-ai/typegraph": patch
---

**`paginate()` and `stream()` advance when a full node or edge is selected and the order names a system column.** A query such as `.select((c) => c.u).orderBy("u", "created_at", "desc")` built its continuation cursor from the selected node, which carries `created_at` as `meta.createdAt`, so the cursor held no value for it. `stream()` then yielded the first batch forever, and `paginate({ after })` returned the first page again. The same applied to `valid_from`, `valid_to`, `updated_at` and `deleted_at`, and to an edge alias's `from_id` and `to_id`, in both directions. Projection selects such as `(c) => ({ id: c.u.id })`, and ordering by `id`, `kind` or a property, were not affected. The cursor now reads each system column where a selected node or edge holds it, through the same lookup a projection select uses.
