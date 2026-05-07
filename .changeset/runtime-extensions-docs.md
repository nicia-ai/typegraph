---
"@nicia-ai/typegraph": patch
---

Documentation + runnable example for the runtime-extension feature
shipped in #101. No code changes — purely a documentation drop so the
feature is discoverable for the announcement.

- New docs page `Runtime Extensions` covering the full flow:
  `defineRuntimeExtension`, `Store.evolve` (with ref pattern + eager
  flag), `Store.materializeIndexes`, `Store.deprecateKinds` /
  `undeprecateKinds`, the dynamic-collection escape hatch
  (`store.getNodeCollection(kind)` / `getEdgeCollection(kind)`),
  restart parity, multi-process race recovery recipe, and a trust
  boundary section for LLM-induced schemas.
- New runnable example `examples/16-runtime-extensions.ts` walking
  through the agent-driven schema-induction flow end-to-end:
  compile-time boot → agent proposes Paper kind → operator approves
  via `evolve` → materialize indexes → ingest via dynamic collection
  → soft-deprecate the legacy kind → restart parity verification.
- Sidebar entry under "Guides" and inclusion in the
  `LLMS_SMALL_PAGES` set so the docs are part of the small llms.txt
  context bundle.
- Cross-link from `schema-evolution.md` so users searching for
  "evolving schemas" find the runtime path too.
