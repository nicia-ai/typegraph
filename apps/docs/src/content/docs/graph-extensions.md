---
title: Graph Extensions
description: Extend a TypeGraph schema at runtime — durable, multi-process safe, with full Zod validation and unique-constraint enforcement.
---

Graph extensions let your application declare new node and edge
kinds **at runtime** — durable across restarts, with semantic parity to
compile-time `defineNode` / `defineEdge`. The motivating use case:
**agent-driven schema induction**, where an LLM proposes a typed schema
from a corpus, an operator approves it, and the live graph immediately
ingests under the new schema with no code change or restart.

:::note[See it end-to-end]
For a runnable scenario with an operator-approved agent in TypeScript,
see [Agent-Driven Schema](/examples/agent-driven-schema). For the same
loop driven by an open-weight LLM against public-record clinical data —
with a repair loop and smoke-test pattern — see
[`pdlug/typegraph-clinical-demo`](https://github.com/pdlug/typegraph-clinical-demo).
:::

This guide covers the core verbs:

| Verb                                             | Purpose                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| `defineGraphExtension`                           | Build a typed extension (pure value, no I/O)                      |
| `store.evolve(extension)`                        | Atomically commit a new schema version with the extension applied |
| `store.introspect()`                             | Snapshot the merged schema, persisted extension, version, and hash |
| `store.materializeIndexes()`                     | Run declared `CREATE INDEX` DDL against the live database         |
| `store.deprecateKinds(...)` / `undeprecateKinds` | Soft-deprecate kinds for codegen / lint signaling                 |
| `store.removeKinds(...)`                         | Remove graph-extension-declared kinds from the active schema      |
| `store.materializeRemovals()`                    | Delete rows queued by graph-extension-kind removal                |

For the schema-management primitives that graph extensions ride on top
of, see [Schema Migrations](/schema-management) and [Evolving
Schemas](/schema-evolution).

## When to use graph extensions

Use them when **the kind set is not known at code time**:

- Agent / LLM proposes a new typed schema from observed data.
- Multi-tenant deployments where each tenant defines their own kinds.
- ETL pipelines that ingest sources with shifting structure.
- Plugins / extensions that contribute kinds at install time.

For everything else — kinds you can declare in TypeScript at deploy time
— use the compile-time DSL (`defineNode`, `defineEdge`, `defineGraph`).
The compile-time path is type-safe end-to-end; graph extensions trade
some of that type-safety for the ability to evolve without redeploying.

## A complete example

```ts
import { z } from "zod";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  defineGraphExtension,
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
const proposal = defineGraphExtension({
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
  indexes: [
    {
      entity: "node",
      kind: "Paper",
      name: "paper_by_doi",
      fields: ["doi"],
      unique: true,
    },
  ],
});

// 3. Operator approves; commit atomically.
const evolved = await store.evolve(proposal);

// 4. Use the dynamic-collection accessor (the type system does not
//    widen for extension kinds — see "Reaching extension kinds" below).
const papers = evolved.getNodeCollection("Paper")!;
await papers.create({
  title: "Attention is all you need",
  doi: "10.5555/3295222.3295349",
  year: 2017,
});
```

A complete runnable version is in [`examples/16-graph-extensions.ts`](https://github.com/nicia-ai/typegraph/blob/main/packages/typegraph/examples/16-graph-extensions.ts).

## The graph extension

`defineGraphExtension` accepts a structured value describing the new
kinds. The extension is JSON-serializable — that's load-bearing for
durability (see [Restart parity](#restart-parity-the-load-bearing-invariant)).

### Document format versioning

Every document carries a `version` field (currently `1`). The validator
stamps the version automatically when you call
`defineGraphExtension`, so consumer code never has to set it
explicitly. Stored documents from before this field existed are
treated as `version: 1` (the legacy default).

The forward-compat policy:

- **Additive minor changes** (new optional property modifier, new
  `format` value, new top-level slice within the same major) ride
  forward without bumping `version`. The validator does not reject
  unknown top-level keys, and the persistence-side zod is `.loose()`
  on every nested object — an older runtime reading a newer extension
  silently ignores unknown fields and continues working.
- **Breaking changes** bump `version` to a higher major. An older
  runtime reading a higher-version extension fails with
  `GRAPH_EXTENSION_VERSION_UNSUPPORTED` and an actionable error
  pointing the operator at upgrading the library — there is no
  automatic downgrade path. The current major is exported as
  `CURRENT_GRAPH_EXTENSION_VERSION` for tooling that wants to
  pre-flight check.
- **Legacy extensions** (committed before `version` existed) and
  extensions that explicitly omit `version` are interpreted as
  `LEGACY_GRAPH_EXTENSION_VERSION`, pinned permanently to `1`. This
  is deliberately distinct from `CURRENT`: when a future v2 ships,
  legacy v1 extensions continue parsing as v1 (so the version-mismatch
  path can route them through migration) rather than being silently
  re-classified as v2 by a default-equals-current rule.

```ts
import {
  CURRENT_GRAPH_EXTENSION_VERSION,
  LEGACY_GRAPH_EXTENSION_VERSION,
} from "@nicia-ai/typegraph";

console.log(CURRENT_GRAPH_EXTENSION_VERSION); // 1 (today; bumps with breaking changes)
console.log(LEGACY_GRAPH_EXTENSION_VERSION);  // 1 (always; the pre-versioning default)
```

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

### Relational indexes

Pass `indexes: [...]` at the document top level to declare relational
indexes for graph-extension or compile-time host kinds:

```ts
const proposal = defineGraphExtension({
  nodes: {
    Paper: {
      properties: {
        doi: { type: "string" },
        title: { type: "string", searchable: { language: "english" } },
      },
    },
  },
  indexes: [
    {
      entity: "node",
      kind: "Paper",
      name: "paper_by_doi",
      fields: ["doi"],
      unique: true,
    },
  ],
});
```

Index `name`s are unique across the merged graph. A graph-extension index that
reuses a compile-time index name, or a later extension that reuses an
earlier graph-extension index name for a different declaration, is rejected.

### Edges

Edges follow the same shape as nodes but add `from: [...]` and `to:
[...]` listing the kind names they connect. Both endpoint kinds must
already exist (compile-time or graph-extension) when `evolve()` runs.

### Ontology

Pass `ontology: [{ metaEdge, from, to }, ...]` to declare ontology
relations between kinds (subClassOf, partOf, etc.). The meta-edge name
must match a meta-edge known to the merged graph.

## `store.evolve(extension, options?)`

```ts
const evolved = await store.evolve(extension);
const evolved = await store.evolve(extension, { ref });
const evolved = await store.evolve(extension, { eager: {} });
```

`evolve` is the consumer-facing primitive that drives extension. It:

1. **Catches up to persisted state** — folds any persisted
   extension and deprecation set into the local baseline so a
   stale store doesn't trample another writer's progress.
2. **Merges** the new extension into the baseline graph. Re-declaring
   an existing extension kind with the same shape is a no-op; with a
   non-additive change against existing rows it throws
   `IncompatibleChangeError` (code `INCOMPATIBLE_CHANGE`).
3. **Atomically commits** a new schema version via `commitSchemaVersion`
   (CAS on the active version).
4. **Returns a new `Store<G>`** carrying the extended graph. The type
   parameter `G` does NOT widen — see [Reaching extension
   kinds](#reaching-extension-kinds-from-the-type-system) below.

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

Pass `eager: {}` to materialize indexes immediately after the schema
commit:

```ts
const evolved = await store.evolve(extension, { eager: {} });
```

Or pass options for finer control:

```ts
// Restrict to the extension kind whose index was declared in the
// proposal above.
const evolved = await store.evolve(extension, {
  eager: { kinds: ["Paper"], stopOnError: true },
});
```

Omit `eager` to skip materialization and run `materializeIndexes()`
later.

Per-index failures throw `EagerMaterializationError` AFTER the new
`Store` is constructed and `ref.current` is updated, so the caller can
recover via the ref handle. The schema commit is **not** rolled back
if materialization fails — eager is convenience, not a transaction.

```ts
const ref = { current: store };
try {
  await store.evolve(extension, { ref, eager: {} });
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

## Reaching extension kinds from the type system

TypeScript can't see kinds that don't exist at compile time. The
`Store<G>` returned by `evolve()` keeps the same generic parameter as
the original — `evolved.nodes.Paper` would not type-check.

The escape hatch is `store.getNodeCollection(kind)` and
`store.getEdgeCollection(kind)`, which return a typed
`DynamicNodeCollection` / `DynamicEdgeCollection`:

```ts
const papers = evolved.getNodeCollection("Paper");
if (papers === undefined) {
  throw new Error("Paper kind not registered on this store");
}
await papers.create({ title: "...", doi: "...", year: 2024 });
const all = await papers.find({});
```

The throwing variants `getNodeCollectionOrThrow(kind)` /
`getEdgeCollectionOrThrow(kind)` are the right call when the caller
already knows the kind has been evolved onto the store — they raise
`KindNotFoundError` with the offending `kindName`, `entity`, and host
`graphId` instead of returning `undefined`, so a typo fails loudly at
the call site rather than crashing later on `papers!.create(...)`.

`DynamicNodeCollection` exposes the same CRUD surface as
`store.nodes.X` — `create`, `getById`, `find`, `update`, `delete`,
etc. — but with widened `Node<NodeType>` element types since the
specific Zod schema isn't visible to TypeScript at the call site.

For consumers that need the live Zod schema itself — MCP tool wrappers
that validate inputs before forwarding to `collection.create`, or
agent prompts that want richer JSON Schema than `introspect()`
exposes — `store.getNodePropsSchema(kind)` /
`getNodePropsSchemaOrThrow(kind)` (and the edge counterparts) return
the exact `z.ZodObject` the store uses internally. Identity holds:
`evolved.getNodePropsSchema("Paper")` is the same instance the store
parses against on `papers.create(...)`.

```ts
import { z } from "zod";

const schema = evolved.getNodePropsSchemaOrThrow("Paper");
const parsed = schema.parse(input); // same Zod issues as papers.create surfaces
const jsonSchema = z.toJSONSchema(schema); // for MCP tool descriptions
```

These accessors return only the props validator. Operation-level
checks — uniqueness, endpoint resolution, temporal validity, backend
constraints — still run only through `collection.create` / `update`.
See [Dynamic Props Schema Access](/schemas-stores#dynamic-props-schema-access)
for the full reference.

For codegen consumers, the kind set is reachable by iterating the
registry's `nodeKinds` and `edgeKinds` maps:

```ts
const allNodeKinds = [...store.registry.nodeKinds.keys()];
const allEdgeKinds = [...store.registry.edgeKinds.keys()];
const personType = store.registry.getNodeType("Person"); // NodeType | undefined
```

`KindRegistry` also exposes `hasNodeType(name)` / `hasEdgeType(name)`
for existence checks.

### Querying extension kinds

`store.query()` requires every `from` / `traverse` / `to` kind to be a
compile-time literal in `Store<G>`. The string-keyed siblings
`fromDynamic` / `traverseDynamic` / `optionalTraverseDynamic` /
`toDynamic` admit kinds added via `evolve()` so an MCP server (or any
caller working from kind names in a string variable) can build typed
multi-hop traversals without `as any`:

```ts
const rows = await store.query()
  .fromDynamic("Paper", "p")
  .traverseDynamic("authoredBy", "a")
  .toDynamic("Author", "u")
  .whereNode("p", (p) => p.field("year").number().gte(2020))
  .select((ctx) => ({ paper: ctx.p, author: ctx.u, edge: ctx.a }))
  .execute();
```

Each method runtime-validates against the registry: a typo throws
`KindNotFoundError`, and a `toDynamic` target that isn't a valid
endpoint for the current edge / direction throws `EndpointError`.
Compile-time `from` / `traverse` / `to` are unchanged.

Predicate accessors on dynamic aliases use a `.field(name)`
discriminator:

- `BaseFieldAccessor` methods (`eq`, `isNull`, `in`, `notIn`) are
  available directly on `field("name")`.
- Type-specific predicates sit behind a discriminator method that
  asserts the field's type — `.string()` / `.number()` / `.date()` /
  `.array()` / `.object()` / `.embedding()`. Each validates against the
  registered Zod schema and throws `TypeError` on mismatch, so
  `field("year").string()` against a number field is caught at
  query-build time, not as a silent "method is undefined" later.
- `.field("missing")` throws when the property isn't on the schema.

#### Mixed typed and dynamic aliases

Typed and dynamic aliases interleave freely in one query. The
predicate accessor is resolved per alias — a typed alias keeps its
narrow `StringFieldAccessor` etc., while a dynamic alias gets `.field()`:

```ts
const rows = await store.query()
  .from("Document", "d")              // typed compile-time kind
  .traverseDynamic("taggedWith", "e") // runtime edge
  .toDynamic("Tag", "n")              // runtime target
  .whereNode("d", (d) => d.title.eq("the doc"))                    // typed: direct
  .whereNode("n", (n) => n.field("label").string().eq("research")) // dynamic: discriminator
  .select((ctx) => ({ doc: ctx.d, tag: ctx.n }))
  .execute();
```

A typed `traverse("typedEdge", "e")` followed by `.toDynamic(target, "n")`
keeps the edge alias `e` typed — `e.role.eq(...)` works directly, no
discriminator needed. Only the dynamic-declared aliases use `.field()`.

#### Optional dynamic traversal

`optionalTraverseDynamic` is the LEFT-JOIN sibling — papers without
authors still surface, with the edge and target aliases as `undefined`:

```ts
const rows = await store.query()
  .fromDynamic("Paper", "p")
  .optionalTraverseDynamic("authoredBy", "a")
  .toDynamic("Author", "u")
  .select((ctx) => ({ paper: ctx.p, author: ctx.u, edge: ctx.a }))
  .execute();
// row.author and row.edge are undefined for papers without an authoredBy edge.
```

### Search facade

The `store.search` facade — `fulltext`, `vector`, `hybrid`, and
`rebuildFulltext` — accepts any registered kind, compile-time or
runtime, with no type cast. The hit's `node` type narrows to the
concrete typed node only when the kind literal is statically known
in `Store<G>`; extension kinds widen to the base `Node`. Misspelled
kind names throw `KindNotFoundError` at the call site instead of
returning empty results.

```ts
// Compile-time kind: hit.node.title is narrowed.
const compileTimeHits = await store.search.fulltext("Document", {
  query: "climate",
  limit: 10,
});

// Extension kind: same call shape, no cast. hit.node is the base
// `Node` shape since "Paper" isn't in the static `G`.
const runtimeHits = await store.search.fulltext("Paper", {
  query: "attention transformer",
  limit: 10,
});
```

## `store.introspect()`

`introspect()` returns a frozen snapshot of the merged schema and the
durable-state metadata the store has loaded so far. Its shape:

| Field                  | Type                                  | Notes                                                                                          |
| ---------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `graphId`              | `string`                              | The graph's stable id.                                                                         |
| `kinds`                | `readonly KindIntrospection[]`        | Merged node kinds with `origin: "compile-time" \| "runtime"`, description, annotations, etc.   |
| `edges`                | `readonly EdgeIntrospection[]`        | Merged edge kinds with the same origin discriminator and endpoint information.                 |
| `ontology`             | `readonly OntologyIntrospection[]`    | Ontology relations declared on either tier.                                                    |
| `deprecatedKinds`      | `ReadonlySet<string>`                 | Kinds flagged via `deprecateKinds(...)`. Informational, not a gate.                            |
| `extension`            | `GraphExtension \| undefined`         | The persisted graph-extension document, or `undefined` when no extensions have been committed. |
| `schemaVersion`        | `number \| undefined`                 | Active schema version on the backend. `undefined` until the first commit.                      |
| `schemaHash`           | `string \| undefined`                 | Hash of the active schema document. `undefined` under the same condition.                      |

```ts
const intro = store.introspect();
console.log(intro.schemaVersion); // e.g. 2
console.log(intro.extension?.nodes?.Paper); // ExtensionNodeDef or undefined
console.log([...intro.deprecatedKinds]);    // ["LegacyDocument"]
```

The `extension` field round-trips: passing it back through
`defineGraphExtension(intro.extension!)` and `evolve()` against an
empty graph reconstructs the same extension kinds.

## `store.materializeIndexes(options?)`

```ts
const result = await store.materializeIndexes();
// Restrict to specific compile-time or extension kinds.
const result = await store.materializeIndexes({ kinds: ["Paper"] });
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

Graph-extension-declared relational indexes use the same declaration shape as
compile-time `defineNodeIndex` / `defineEdgeIndex`, but in a
JSON-serializable form. They are persisted in `schema_doc.extension`,
re-derived on restart, and surface in `store.graph.indexes` with
`origin: "runtime"`.

### Vector indexes

Vector indexes are **auto-derived** from `embedding()` brands on both
compile-time and extension node kinds. Every top-level node field
declared with `embedding(dims, opts?)` produces one
`VectorIndexDeclaration` that flows through `materializeIndexes()`
like any relational index. No extra wiring required.

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
console.log([...store.introspect().deprecatedKinds]); // ["LegacyDocument"]

await store.undeprecateKinds(["LegacyDocument"]);
```

Soft-deprecation surfaces in
`store.introspect().deprecatedKinds: ReadonlySet<string>` for
introspection (codegen, UI tooling, lints) but does not gate reads,
writes, or queries. Bumps the schema version like any other change;
idempotent — re-deprecating an already-deprecated kind is a no-op.

Use cases:

- Codegen routes around deprecated kinds when generating new client
  code.
- Lint rules flag new code that touches deprecated kinds.
- UI tooling hides deprecated kinds from picker menus.

## `store.removeKinds(...)` / `materializeRemovals()`

`removeKinds()` removes graph-extension-declared kinds from the active schema.
It is intentionally two-phase:

1. **Schema commit.** `removeKinds(names)` rewrites the persisted graph
   extension without the named graph-extension kinds, cascades extension edges
   and ontology relations that can no longer resolve, and commits a
   new schema version with CAS.
2. **Data cleanup.** `materializeRemovals()` deletes rows for removed
   node and edge kinds on the current deployment.

```ts
const withoutPaper = await evolved.removeKinds(["Paper"]);
await withoutPaper.materializeRemovals();
```

Pass `{ eager: {} }` to run cleanup inline after the schema commit:

```ts
const withoutPaper = await evolved.removeKinds(["Paper"], { eager: {} });
```

Removal only applies to graph-extension-declared kinds. Removing a compile-time
kind throws `RemoveCompileTimeKindError`; deploy new TypeScript code
for compile-time schema removal. Removing a graph-extension kind that is still
referenced by a compile-time edge or ontology relation throws
`KindHasReferentsError`, because TypeGraph cannot rewrite your
compiled graph for you.

## Restart parity (the load-bearing invariant)

The graph extension is the **durable source of truth**.
Every call to `evolve()` persists the merged document into
`schema_doc.extension`. On startup, `createStoreWithSchema()`
reads it back, runs the same compiler, and reconstructs identical
Zod-bearing `GraphDef`. Net: an extension kind defined via `evolve()` is
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
  extension: GraphExtension,
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
      // SchemaContentConflictError, GraphExtensionValidationError,
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
`deprecateKinds`, `materializeIndexes`) folds the persisted graph-extension
document and deprecation set into the local baseline before computing
the next state, so a stale store applying an extension on top of an
out-of-date baseline doesn't trample another writer's progress.

## Trust boundary

When the graph extension originates from an **untrusted
source** — an LLM completion, user input, an external API — treat it
as untrusted data. Specifically:

- **Validation runs at the boundary.** `defineGraphExtension(doc)`
  rejects any input that doesn't match the v1 subset
  (`GraphExtensionValidationError` with per-issue paths). Don't skip
  this step. If you want Result-style handling for untrusted JSON, call
  `validateGraphExtension(raw, { strict: true })` and surface the
  structured issues before calling `evolve()`.
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

- **Fulltext index unification.** Vector indexes flow through the
  unified channel (auto-derived from `embedding()` brands). Fulltext
  is still per-strategy: the GIN / FTS5 index is created with the
  fulltext table at `bootstrapTables` time. Per-kind fulltext indexes
  are reserved for future work.
- **Multiple vector indexes per (kind, field).** v1 allows at most
  one. To use a different metric for the same field, use a different
  field name or wait for v2.
- **Hard-blocking reads/writes on deprecated kinds.** Deprecation is
  informational. If you want strict enforcement, wrap collection
  access yourself.
- **Auto drop+recreate on signature drift.** `materializeIndexes`
  surfaces drift as a `failed` result; manual remediation is required
  to avoid risky lock semantics.

## See also

- [Schema Migrations](/schema-management) — the lower-level primitives `evolve()` rides on.
- [Evolving Schemas](/schema-evolution) — recipes for compile-time schema changes.
- [Errors](/errors) — `EagerMaterializationError`, `GraphExtensionValidationError`, `StaleVersionError`, `SchemaContentConflictError`.
