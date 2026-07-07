---
"@nicia-ai/typegraph": patch
---

Fixes `.select()` query projections losing the `NodeId<N>`/`EdgeId<E>` brand on
`id` fields. Previously `ctx.alias.id` in a `.select()` callback was typed as
plain `string`, so feeding a projected id back into `getById`/`getByIds`
required an unsafe cast (`as never` or worse). `SelectableNode<N>.id` and
`SelectableEdge<E>.id` are now typed `NodeId<N>`/`EdgeId<E>`, matching what
`getById`/`getByIds` already require — no runtime change, no cast needed.

`SelectableEdge.fromId`/`.toId` are unaffected (still plain `string`); see
#235 for that follow-up.
