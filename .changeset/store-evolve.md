---
"@nicia-ai/typegraph": minor
---

Add `Store.evolve(extension, options?)` and the `StoreRef<T>` type — the public ergonomic for runtime-extending a graph at runtime. This is the headline of the runtime-extension feature (issue #101 PR 5/6); index materialization (`store.materializeIndexes`) lands in PR 6, and the deprecation marker (`store.deprecateKinds`) lands separately.

## The two consumer patterns

**Single-caller / let-rebind.** The common case — a script, test, or service with one entry point. `evolve()` returns the new store; reassign:

```typescript
import { createStoreWithSchema, defineRuntimeExtension } from "@nicia-ai/typegraph";

let [store] = await createStoreWithSchema(graph, backend);

const extension = defineRuntimeExtension({
  nodes: { Paper: { properties: { doi: { type: "string" } } } },
});

store = await store.evolve(extension);
// `store` now carries Paper alongside the original compile-time kinds.
```

**Many-caller / consumer-composed ref.** When request handlers, background workers, or an agent loop share the store reference and you can't reassign at every call site. Compose a `StoreRef`, share `ref` (not `ref.current`), pass it to `evolve` to be re-pointed atomically with the schema commit:

```typescript
import {
  createStoreWithSchema,
  defineRuntimeExtension,
  type StoreRef,
} from "@nicia-ai/typegraph";

const [store] = await createStoreWithSchema(graph, backend);
const ref: StoreRef<typeof store> = { current: store };

// Long-lived consumers hold `ref` and dereference at use time:
async function handleRequest(): Promise<void> {
  await ref.current.nodes.Paper?.create({ doi: "..." });
}

// Evolve re-points the ref atomically:
await ref.current.evolve(extension, { ref });
// All consumers dereferencing through `ref` now see Paper.
```

`StoreRef<T>` is `{ current: T }` — a plain mutable handle. No event/subscription machinery; consumers wrap if they need eventing. There's no dedicated `createStoreRef` factory: composing the ref is one line and keeps the library API surface minimal.

## `Store.evolve(extension, options?)`

Validates the document, atomically commits a new schema version through the `commitSchemaVersion` primitive (CAS on the active version), constructs a fresh `Store<G>` against the merged graph, and returns it. Cost is proportional to schema document size, not row count — `evolve()` never reads or scans data rows.

**Additive-only semantics.** v1 extensions are additive over the canonical document:

- New kinds, new edges referencing existing kinds (compile-time or runtime), and new ontology relations: **allowed**.
- Re-declaring an existing runtime kind with the **same shape**: **no-op** (idempotent re-evolve).
- Re-declaring an existing runtime kind with a **different shape**: **rejected** with `ConfigurationError` (`code: "RUNTIME_KIND_REDEFINITION"`). Use a new kind name to evolve a kind in v1.
- Collisions with **compile-time** kinds: rejected with `RUNTIME_KIND_NAME_COLLISION`.

**Concurrent evolve.** Two simultaneous calls produce one winner — the loser surfaces `StaleVersionError` or `SchemaContentConflictError` from the commit primitive, depending on whether the race resolved at the active-pointer or content-hash check. Recovery: refetch the active schema, reconstruct your `Store` (or dereference your `StoreRef`), and re-call `evolve(extension)`. Re-validation may now surface deterministic errors (e.g., a kind another caller just added that collides with yours) — don't loop blindly.

The agent-loop hot path of repeated same-extension `evolve()` short-circuits in `mergeRuntimeExtension` via a structural-equal union check, so no-op evolves skip compile + filter + merge entirely and `Store.evolve` returns `this` to keep warm caches.

## v1 string property formats

The supported `format` values widened: `"datetime" | "uri" | "email" | "uuid" | "date"`. Each routes to the corresponding Zod factory (`z.iso.datetime()`, `z.url()`, `z.email()`, `z.uuid()`, `z.iso.date()`). Other JSON-Schema formats remain rejected at validation time with a usable error.

## Acceptance gates

- **Round-trip parity:** for every public Store API path covered (create, getById, find, count, update, delete, edge endpoint resolution), a kind added via `evolve()` produces identical results to the same kind declared at compile time. Runtime kinds are reached through `store.getNodeCollection(kind)` since the type system doesn't see them.
- **Cross-kind traversal:** runtime edges between runtime and compile-time kinds are queryable end-to-end via `findFrom` / `findTo` — exercises the actual data path through the merged graph.
- **Concurrent evolve:** two simultaneous `evolve()` calls produce exactly one winner; the loser is rejected with `StaleVersionError | SchemaContentConflictError`.
- **Additive-merge enforcement:** redefining an existing runtime kind with a different shape is rejected with `RUNTIME_KIND_REDEFINITION`; same-shape re-evolves are idempotent.

## Out of scope

Per the issue's v1 pinning:

- `unique`-on-populated-kind rejection — in v1 runtime extensions only ADD new kinds (collisions rejected outright), so every runtime kind is brand new with no rows. The rule becomes meaningful when `mode: "merge"` lands.
- Modifying an existing runtime kind — covered by the additive-only rule above; use a new kind name.
- `materializeIndexes()` — PR 6.
- `deprecateKinds()` — separate PR.
- Cross-store auto-refresh — `StoreRef` is the re-binding affordance; auto-refresh is a separate observability concern.
- Numeric / boolean enums — v1 enum is `readonly string[]` only.
