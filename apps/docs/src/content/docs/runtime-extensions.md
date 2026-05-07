---
title: Runtime Graph Extensions
description: Extend a TypeGraph schema at runtime — durable, multi-process safe, with full Zod validation and unique-constraint enforcement.
---

Runtime graph extensions let your application declare new node and edge
kinds **at runtime** — durable across restarts, with semantic parity to
compile-time `defineNode` / `defineEdge`. The motivating use case:
**agent-driven schema induction**, where an LLM proposes a typed schema
from a corpus, an operator approves it, and the live graph immediately
ingests under the new schema with no code change or restart.

This guide covers the four verbs:

| Verb                       | Purpose                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| `defineRuntimeExtension`   | Build a typed extension document (pure value, no I/O)                    |
| `store.evolve(extension)`  | Atomically commit a new schema version with the extension applied       |
| `store.materializeIndexes()` | Run declared `CREATE INDEX` DDL against the live database              |
| `store.deprecateKinds(...)` | Soft-deprecate kinds for codegen / lint signaling                       |

For the schema-management primitives that runtime extensions ride on top
of, see [Schema Migrations](/schema-management) and [Evolving
Schemas](/schema-evolution).

## When to use runtime extensions

Use them when **the kind set is not known at code time**:

- Agent / LLM proposes a new typed schema from observed data.
- Multi-tenant deployments where each tenant defines their own kinds.
- ETL pipelines that ingest sources with shifting structure.
- Plugins / extensions that contribute kinds at install time.

For everything else — kinds you can declare in TypeScript at deploy time
— use the compile-time DSL (`defineNode`, `defineEdge`, `defineGraph`).
The compile-time path is type-safe end-to-end; runtime extensions trade
some of that type-safety for the ability to evolve without redeploying.

## A complete example

```ts
import { z } from "zod";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  defineRuntimeExtension,
} from "@nicia-ai/typegraph";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite/local";

// 1. Boot with a compile-time kind.
const Document = defineNode("Document", {
  schema: z.object({ title: z.string(), body: z.string() }),
});
const baseGraph = defineGraph({
  id: "research_corpus",
  nodes: { Document: { type: Document } },
  edges: {},
});

const { backend } = createLocalSqliteBackend();
const [store] = await createStoreWithSchema(baseGraph, backend);

// 2. An agent proposes a new kind at runtime.
const proposal = defineRuntimeExtension({
  nodes: {
    Paper: {
      description: "An academic paper inferred from the corpus",
      properties: {
        title: { type: "string", minLength: 1 },
        doi: { type: "string", minLength: 1 },
        year: { type: "number", int: true, min: 1900, max: 2100 },
      },
      unique: [{ name: "paper_doi_unique", fields: ["doi"] }],
    },
  },
});

// 3. Operator approves; commit atomically.
const evolved = await store.evolve(proposal);

// 4. Use the dynamic-collection accessor (the type system does not
//    widen for runtime kinds — see "Reaching runtime kinds" below).
const papers = evolved.getNodeCollection("Paper")!;
await papers.create({
  title: "Attention is all you need",
  doi: "10.5555/3295222.3295349",
  year: 2017,
});
```

A complete runnable version is in [`examples/16-runtime-extensions.ts`](https://github.com/nicia-ai/typegraph/blob/main/packages/typegraph/examples/16-runtime-extensions.ts).

## The runtime extension document

`defineRuntimeExtension` accepts a structured value describing the new
kinds. The document is JSON-serializable — that's load-bearing for
durability (see [Restart parity](#restart-parity-the-load-bearing-invariant)).

### Property types (the v1 subset)

The following types are supported. The set is deliberately small so that
LLM-induced schemas can be audited at a glance and so the persistence
layer never has to reconstruct opaque Zod refinements from JSON.

| Type      | JSON shape                                                                |
| --------- | ------------------------------------------------------------------------- |
| `string`  | `{ type: "string", minLength?, maxLength?, pattern?, format? }`           |
| `number`  | `{ type: "number", int?, min?, max? }`                                    |
| `boolean` | `{ type: "boolean" }`                                                     |
| `enum`    | `{ type: "enum", values: ["a", "b", ...] }`                               |
| `array`   | `{ type: "array", items: <leaf or single-level object> }`                 |
| `object`  | `{ type: "object", properties: { foo: <leaf>, ... } }` (one nesting only) |

Supported string formats: `"datetime"`, `"uri"`, `"email"`, `"uuid"`,
`"date"`. These route to the corresponding Zod factories
(`z.iso.datetime()`, `z.url()`, `z.email()`, `z.uuid()`, `z.iso.date()`).

Modifiers available on every property:

- `optional?: true` — omits from the required set.
- `description?: string` — surfaces in tooling.
- `searchable?: SearchableModifier` — string only; routes through the
  `searchable()` brand for fulltext indexing.
- `embedding?: { dimensions: number }` — array-of-number only; routes
  through the `embedding()` brand for vector search.

### Unique constraints

Pass `unique: [{ name, fields, ... }]` per kind. The `name` is required
(used as the diffing identity key) and must be unique within the kind.
Supports `scope`, `collation`, and a restricted `where` clause limited
to `isNull` / `isNotNull` (the only operations round-trippable through
the persisted form).

### Edges

Edges follow the same shape as nodes but add `from: [...]` and `to:
[...]` listing the kind names they connect. Both endpoint kinds must
already exist (compile-time or runtime) when `evolve()` runs.

### Ontology

Pass `ontology: [{ metaEdge, from, to }, ...]` to declare ontology
relations between kinds (subClassOf, partOf, etc.). The meta-edge name
must match a meta-edge known to the merged graph.

## `store.evolve(extension, options?)`

```ts
const evolved = await store.evolve(extension);
const evolved = await store.evolve(extension, { ref });
const evolved = await store.evolve(extension, { eager: true });
```

`evolve` is the consumer-facing primitive that drives runtime
extension. It:

1. **Catches up to persisted state** — folds any persisted
   runtimeDocument and deprecation set into the local baseline so a
   stale store doesn't trample another writer's progress.
2. **Merges** the new extension into the baseline graph. Re-declaring
   an existing runtime kind with the same shape is a no-op; with a
   different shape it throws `RUNTIME_KIND_REDEFINITION`.
3. **Atomically commits** a new schema version via `commitSchemaVersion`
   (CAS on the active version).
4. **Returns a new `Store<G>`** carrying the extended graph. The type
   parameter `G` does NOT widen — see [Reaching runtime
   kinds](#reaching-runtime-kinds-from-the-type-system) below.

### The `ref` pattern

`Store<G>` is immutable by construction — `evolve()` returns a fresh
instance. Long-lived consumer code that holds the store in a singleton
needs a way to re-bind it atomically with the schema commit. Pass
`options.ref: { current: store }` (a `StoreRef<Store<G>>`):

```ts
const ref: StoreRef<Store<G>> = { current: store };
await ref.current.evolve(extension, { ref });
// `ref.current` now points to the new store.
```

`StoreRef<T>` is just a type alias for `{ current: T }` — the library
doesn't provide a factory because the consumer composes the handle
themselves (could be a Vue ref, MobX observable, Zustand atom, etc.).

### Eager materialization

Pass `eager: true` to materialize indexes immediately after the schema
commit:

```ts
const evolved = await store.evolve(extension, { eager: true });
```

Or pass options:

```ts
// Restrict to compile-time kinds that actually carry indexes (v1
// runtime extensions don't carry relational indexes — see "v1 scope"
// below). `Document` is from the worked example at the top of this
// page.
const evolved = await store.evolve(extension, {
  eager: { kinds: ["Document"], stopOnError: true },
});
```

Per-index failures throw `EagerMaterializationError` AFTER the new
`Store` is constructed and `ref.current` is updated, so the caller can
recover via the ref handle. The schema commit is **not** rolled back
if materialization fails — eager is convenience, not a transaction.

```ts
const ref = { current: store };
try {
  await store.evolve(extension, { ref, eager: true });
} catch (error) {
  if (error instanceof EagerMaterializationError) {
    // Schema is committed; ref.current is the new store.
    log.warn(
      { failed: error.failedIndexNames },
      "indexes did not materialize; will retry",
    );
    await ref.current.materializeIndexes();
  } else {
    throw error;
  }
}
```

## Reaching runtime kinds from the type system

TypeScript can't see kinds that don't exist at compile time. The
`Store<G>` returned by `evolve()` keeps the same generic parameter as
the original — `evolved.nodes.Paper` would not type-check.

The escape hatch is `store.getNodeCollection(kind)` and
`store.getEdgeCollection(kind)`, which return a typed `DynamicNode
Collection` / `DynamicEdgeCollection`:

```ts
const papers = evolved.getNodeCollection("Paper");
if (papers === undefined) {
  throw new Error("Paper kind not registered on this store");
}
await papers.create({ title: "...", doi: "...", year: 2024 });
const all = await papers.find({});
```

`DynamicNodeCollection` exposes the same CRUD surface as
`store.nodes.X` — `create`, `getById`, `find`, `update`, `delete`,
etc. — but with widened `Node<NodeType>` element types since the
specific Zod schema isn't visible to TypeScript at the call site.

For codegen consumers, the kind set is reachable by iterating the
registry's `nodeKinds` and `edgeKinds` maps:

```ts
const allNodeKinds = [...store.registry.nodeKinds.keys()];
const allEdgeKinds = [...store.registry.edgeKinds.keys()];
const personType = store.registry.getNodeType("Person"); // NodeType | undefined
```

`KindRegistry` also exposes `hasNodeType(name)` / `hasEdgeType(name)`
for existence checks.

## `store.materializeIndexes(options?)`

```ts
const result = await store.materializeIndexes();
// Restrict to specific compile-time kinds. Filtering by a v1 runtime
// kind is a no-op because runtime extensions don't carry relational
// indexes yet — see "v1 scope" below.
const result = await store.materializeIndexes({ kinds: ["Document"] });
const result = await store.materializeIndexes({ stopOnError: true });
```

`materializeIndexes` runs `CREATE INDEX` DDL for the indexes declared
on the merged graph and tracks per-deployment status in
`typegraph_index_materializations`. It's a separate verb from
`evolve()` because:

- DDL is **per-database**, not per-graph (two replicas of the same
  `schema_doc` are still two databases — DDL has to run on each).
- Postgres uses `CREATE INDEX CONCURRENTLY` so live tables never take
  an `AccessExclusiveLock`. CIC cannot run inside a transaction, which
  is why `materializeIndexes` runs at the top-level backend, never
  inside `transaction()`.
- Best-effort by default: per-index failures land in the result with
  the captured `Error` and the loop continues. Pass
  `stopOnError: true` to halt on the first failure.

The returned `MaterializeIndexesResult` has one entry per declared
index with `status: "created" | "alreadyMaterialized" | "failed" | "skipped"`.
The `skipped` status surfaces when the backend recognizes the
declaration but can't act on it in its current configuration — e.g.
vector indexes against SQLite without the `sqlite-vec` extension, or
`embedding(dims, { indexType: "none" })` opting out of automatic
materialization.

### Vector indexes

Vector indexes are **auto-derived** from `embedding()` brands at
`defineGraph()` time. Every top-level node field declared with
`embedding(dims, opts?)` produces one `VectorIndexDeclaration` that
flows through `materializeIndexes()` like any relational index. No
extra wiring required.

```ts
const Document = defineNode("Document", {
  schema: z.object({
    title: z.string(),
    // Auto-derives a cosine HNSW vector index with pgvector
    // defaults (m=16, ef_construction=64).
    embedding: embedding(384),
  }),
});

// Customize the auto-derived index by passing options at the brand.
const Image = defineNode("Image", {
  schema: z.object({
    embedding: embedding(512, { metric: "l2", m: 32, efConstruction: 100 }),
  }),
});

// Opt out of automatic materialization while keeping the embedding.
const Manual = defineNode("Manual", {
  schema: z.object({
    embedding: embedding(384, { indexType: "none" }),
  }),
});
```

On `materializeIndexes()`:

- Postgres with pgvector: emits `CREATE INDEX ... USING hnsw ...` (or
  `ivfflat`) on `typegraph_node_embeddings` and reports `created`.
- SQLite with `sqlite-vec`: vectors are stored but the brute-force
  scan IS the "index"; declarations report `skipped` because
  HNSW/IVFFlat aren't available natively on SQLite.
- SQLite without `sqlite-vec`: declarations report `skipped` with a
  reason indicating the backend lacks vector support.

The vector declaration's identity key within a single graph is
`(kind, fieldPath)` — v1 allows at most one vector index per
(kind, field) pair. The auto-derived deterministic declaration
name is `tg_vec_{kind}_{field}_{metric}` — clean and scannable for
inspection in `pg_indexes` and result entries. Changing the metric
requires a different declaration name and explicit
re-materialization.

Cross-graph disambiguation lives at the materialization boundary,
not in the declaration name. Vector status rows in
`typegraph_index_materializations` are keyed on the compound
`{graphId}::{declaration.name}` for both auto-derived and explicit
`VectorIndexDeclaration` entries — so two graphs reusing the same
declaration name (whether auto-derived from the same kind/field or
constructed explicitly via `defineGraph({ indexes: [...] })`) don't
collide in the status table. Each graph's `materializeIndexes()`
call creates its own physical pgvector index (which is itself
partial-by-graph_id) and records its own status row.

### Fulltext indexes (out of scope for v1)

Fulltext indexes are NOT in the unified declaration channel for v1.
The fulltext table's canonical index (Postgres GIN on `tsv`, SQLite
FTS5 virtual table) is created with the table itself by
`bootstrapTables` per the active `FulltextStrategy`. Per-kind fulltext
indexes are an "advanced strategy" surface that doesn't fit the
relational-style declaration model and is reserved for future work.

### Caveats (Postgres)

- `IF NOT EXISTS` does not validate shape — only that something with
  that name exists. Drift detection uses TypeGraph's recorded
  signature, not PG metadata. Signature mismatch surfaces as
  `failed` with a `different signature` message.
- Failed `CONCURRENTLY` builds leave invalid indexes
  (`pg_index.indisvalid = false`). v1 surfaces this as a `failed`
  result; the operator drops the invalid index manually before retry.

## `store.deprecateKinds(...)` / `undeprecateKinds(...)`

```ts
await store.deprecateKinds(["LegacyDocument"]);
console.log([...store.deprecatedKinds]); // ["LegacyDocument"]

await store.undeprecateKinds(["LegacyDocument"]);
```

Soft-deprecation surfaces in `store.deprecatedKinds: ReadonlySet<string>`
for introspection (codegen, UI tooling, lints) but does not gate reads,
writes, or queries. Bumps the schema version like any other change;
idempotent — re-deprecating an already-deprecated kind is a no-op.

Use cases:

- Codegen routes around deprecated kinds when generating new client
  code.
- Lint rules flag new code that touches deprecated kinds.
- UI tooling hides deprecated kinds from picker menus.

For full removal of a runtime-declared kind, see [Out of
scope](#out-of-scope-for-v1) below.

## Restart parity (the load-bearing invariant)

The runtime extension document is the **durable source of truth**.
Every call to `evolve()` persists the merged document into
`schema_doc.runtimeDocument`. On startup, `createStoreWithSchema()`
reads it back, runs the same compiler, and reconstructs identical
Zod-bearing `GraphDef`. Net: a runtime kind defined via `evolve()` is
indistinguishable from a compile-time kind after restart.

Verify this in your own tests:

```ts
const [store] = await createStoreWithSchema(baseGraph, backend);
const evolved = await store.evolve(proposal);
await evolved.getNodeCollection("Paper")!.create({ title: "...", doi: "...", year: 2024 });

// Different process / different deployment / fresh store...
const [restored] = await createStoreWithSchema(baseGraph, backend);
expect(restored.registry.hasNodeType("Paper")).toBe(true);
const all = await restored.getNodeCollection("Paper")!.find({});
expect(all).toHaveLength(1);
```

## Multi-process safety

Concurrent writers compete on the `commitSchemaVersion` CAS. One wins;
the loser sees one of two errors with very different recovery semantics:

- **`StaleVersionError`** — the local view of the active version is out
  of date. Routine race signal: refetch and retry.
- **`SchemaContentConflictError`** — a different writer wrote a row at
  the same version with a different content hash. NOT a routine race.
  Two writers tried to commit semantically different schemas at the
  same version, which means one of them is operating on an inconsistent
  view of the world. Surface to the operator; do not blindly retry.

Retry recipe (only catches `StaleVersionError`):

```ts
async function evolveWithRetry<G extends GraphDef>(
  ref: StoreRef<Store<G>>,
  extension: RuntimeGraphDocument,
  attempts = 3,
): Promise<Store<G>> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await ref.current.evolve(extension, { ref });
    } catch (error) {
      if (error instanceof StaleVersionError) {
        // Refetch happens implicitly inside evolve()'s next call —
        // catch-up auto-merges the persisted state into the local
        // baseline, so the next attempt diffs against fresh state.
        continue;
      }
      // SchemaContentConflictError, RuntimeExtensionValidationError,
      // EagerMaterializationError, etc. all surface to the caller —
      // they require operator intervention or different handling, not
      // blind retry.
      throw error;
    }
  }
  throw new Error(`Failed to evolve after ${attempts} attempts`);
}
```

The internal `#catchUpToStored` step inside `evolve()` (and
`deprecateKinds`, `materializeIndexes`) folds the persisted runtime
document and deprecation set into the local baseline before computing
the next state, so a stale store applying an extension on top of an
out-of-date baseline doesn't trample another writer's progress.

## Trust boundary

When the runtime extension document originates from an **untrusted
source** — an LLM completion, user input, an external API — treat it
as untrusted data. Specifically:

- **Validation runs at the boundary.** `defineRuntimeExtension(doc)`
  rejects any input that doesn't match the v1 subset
  (`RuntimeExtensionValidationError` with per-issue paths). Don't skip
  this step.
- **Property types are deliberately small.** The supported set
  excludes things like `bigint`, `Date`, custom Zod refinements, and
  arbitrary functions. An LLM cannot inject executable code by
  proposing an extension document.
- **Operator approval is your gate.** The library doesn't enforce
  human-in-the-loop — your application does. Show the diff to a human
  before calling `evolve()`.
- **Persisted documents are part of your data.** They're stored in
  `schema_doc` along with every other schema artifact; back them up,
  audit them, version-control them.

## Out of scope for v1

- **Removal of runtime-declared kinds.** `deprecateKinds` is the soft
  signal; a hard-removal verb has a long edge-case tail (existing
  rows, edges referencing the kind, ontology references, fulltext /
  embedding rows, tombstoned rows) and deserves its own design pass.
- **Fulltext index unification.** Vector indexes flow through the
  unified channel (auto-derived from `embedding()` brands). Fulltext
  is still per-strategy: the GIN / FTS5 index is created with the
  fulltext table at `bootstrapTables` time. Per-kind fulltext indexes
  are reserved for future work.
- **Multiple vector indexes per (kind, field).** v1 allows at most
  one. To use a different metric for the same field, use a different
  field name or wait for v2.
- **Vector index for runtime-declared kinds.** Auto-derivation walks
  compile-time node schemas. Runtime-extension documents cannot yet
  declare embeddings — coming in a follow-up.
- **Hard-blocking reads/writes on deprecated kinds.** Deprecation is
  informational. If you want strict enforcement, wrap collection
  access yourself.
- **Auto drop+recreate on signature drift.** `materializeIndexes`
  surfaces drift as a `failed` result; manual remediation is required
  to avoid risky lock semantics.

## See also

- [Schema Migrations](/schema-management) — the lower-level primitives `evolve()` rides on.
- [Evolving Schemas](/schema-evolution) — recipes for compile-time schema changes.
- [Errors](/errors) — `EagerMaterializationError`, `RuntimeExtensionValidationError`, `StaleVersionError`, `SchemaContentConflictError`.
