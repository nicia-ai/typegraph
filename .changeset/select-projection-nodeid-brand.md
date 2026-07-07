---
"@nicia-ai/typegraph": patch
---

Fixes `.select()` query projections losing the `NodeId<N>` brand on node `id`
fields. Previously `ctx.alias.id` in a `.select()` callback was typed as plain
`string`, so feeding a projected node id back into `getById`/`getByIds`
required an unsafe cast (`as never` or worse). `SelectableNode<N>.id` is now
typed `NodeId<N>`, matching what `getById`/`getByIds` already require — no
runtime change, no cast needed.

Edge ids from `.select()` stay plain `string` on purpose: `traverse()`
defaults to `expand: "inverse"`, which can back an edge alias with a row of
the registered *inverse* edge kind, so the alias's static edge type doesn't
reliably describe the row. Use `asEdgeId` to re-brand a projected edge id
before a point read.
