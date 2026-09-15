---
"@nicia-ai/typegraph": minor
---

Add an optional database-expression `filter` to `expr.collect(value, { orderBy, filter })`. SQL TRUE includes an element, while false and SQL NULL exclude it. Aggregate-local filtering preserves parent groups from optional traversals, so missing children can produce `[]` without removing the parent row; included NULL operands still decode to `undefined` and keep the collection's inferred element type.

Keep scalar values and explicit nonempty ordering as the collection contract. `distinct` and aggregate-local `limit` remain unsupported, and collection expressions retain their dedicated `kind: "collect"` node.

Change custom dialect adapters to accept one required `{ value, valueType, orderBy, filter }` argument in `orderedScalarJsonArray`. Apply the optional filter inside the aggregate before empty-input coalescing, preserve included NULL operands, and return `[]` for empty input. The existing `orderedAggregates: true` capability remains the declaration for filtered collections.
