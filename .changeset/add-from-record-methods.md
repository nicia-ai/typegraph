---
"@nicia-ai/typegraph": minor
---

Add `createFromRecord()` and `upsertByIdFromRecord()` to `NodeCollection`.

These methods accept `Record<string, unknown>` instead of `z.input<N["schema"]>`, providing an escape hatch for dynamic-data scenarios (changesets, migrations, imports) where the data shape is determined at runtime. Runtime Zod validation is unchanged — only the compile-time type gate is relaxed. The return type remains fully typed as `Node<N>`.

Closes #37.
