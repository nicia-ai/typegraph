# @nicia-ai/typegraph

## 0.25.0

### Minor Changes

- [#106](https://github.com/nicia-ai/typegraph/pull/106) [`40b97b1`](https://github.com/nicia-ai/typegraph/commit/40b97b1b5fe3a858830f9fd3619db1ed7f10ec54) Thanks [@pdlug](https://github.com/pdlug)! - Replace the unwrapped `insertSchema` + `setActiveSchema` two-step migration flow with a single atomic `commitSchemaVersion` backend primitive (plus `setActiveVersion` for rollback). Fixes the orphan-row bug where a crash between insert and activate left the system wedged at the next `ensureSchema` call.

  **The bug.** `migrateSchema` called `backend.insertSchema(v=N+1, isActive=false)` then `backend.setActiveSchema(N+1)` as two independent operations with no surrounding transaction. A crash in between left an inactive `v=N+1` row that nothing referenced; the next migration attempt computed the same `newVersion=N+1` and hit a primary-key violation, requiring manual operator cleanup. Closes [#104](https://github.com/nicia-ai/typegraph/issues/104).

  **New primitives:**

  ```typescript
  backend.commitSchemaVersion({
    graphId,
    expected: { kind: "initial" } | { kind: "active"; version: N },
    version: N + 1,
    schemaHash,
    schemaDoc,
  });

  backend.setActiveVersion({ graphId, expected, version });
  ```

  `commitSchemaVersion` inserts and activates as one transactional unit with optimistic compare-and-swap on the currently-active version, idempotency on same-hash retry (orphan reactivation), and explicit conflict detection. The CAS guard takes a tagged-union `expected` rather than a magic `version: 0` sentinel — initial commits have materially different semantics from successor commits and the type system reflects that.

  **New error types** (both extend `TypeGraphError`):
  - `StaleVersionError` — thrown when the caller's `expected` active version doesn't match what the database has. Includes `details.actual` so the caller knows what to refetch. Recovery: re-read with `getActiveSchema(graphId)` and retry against the new baseline.
  - `SchemaContentConflictError` — thrown when a row already exists at the target version with a different `schemaHash`. This is a content disagreement (two writers committed different schemas at the same version), not a stale-read race; recovery requires operator intervention, not retry.

  **Storage-layer invariant.** Adds a partial unique index `(graph_id) WHERE is_active = TRUE` on `typegraph_schema_versions`. Defense in depth: the database will refuse a corrupt "two active rows on one graph" state regardless of the application path that produced it.

  **Non-transactional backends refuse the primitive.** On Cloudflare D1, Cloudflare Durable Objects, `drizzle-orm/neon-http`, and any SQLite backend configured with `transactionMode: "none"`, `commitSchemaVersion` and `setActiveVersion` throw `ConfigurationError`. The orphan-row crash window cannot be eliminated without atomicity, so silent best-effort degradation would re-introduce the exact bug this primitive fixes. Run schema migrations from a process with a transactional driver; the edge worker can keep using its non-transactional driver for reads and ordinary writes once the schema is established.

  **Locking.**
  - SQLite: `BEGIN IMMEDIATE` (sync paths) or Drizzle's `behavior: "immediate"` (async paths) acquires a reserved write lock at the start of the transaction so the read-then-write CAS sequence is serialized.
  - Postgres: `pg_advisory_xact_lock(hashtext(graphId))` serializes commits per-graph, covering both the "active row exists" and "initial commit" cases under one mechanism.

  **Breaking changes for backend implementers.** `insertSchema` and `setActiveSchema` are removed from the `GraphBackend` interface; custom backend implementations must implement `commitSchemaVersion` and `setActiveVersion` instead. Callers using the public `initializeSchema`, `migrateSchema`, and `rollbackSchema` helpers from `@nicia-ai/typegraph/schema` need no changes — these now route through the new primitives transparently.

  Existing deployments need to add the partial unique index when they upgrade. `bootstrapTables` regenerates the full DDL set (idempotent; existing tables are unchanged); manually-managed schemas should run an additional `CREATE UNIQUE INDEX IF NOT EXISTS typegraph_schema_versions_one_active_per_graph_idx ON typegraph_schema_versions (graph_id) WHERE is_active = TRUE;` for Postgres or the equivalent `WHERE is_active = 1` for SQLite. Existing data that has only ever maintained one active row per graph will satisfy the constraint — the application path has always done so by convention; the index just makes the invariant structural.

- [#118](https://github.com/nicia-ai/typegraph/pull/118) [`748b513`](https://github.com/nicia-ai/typegraph/commit/748b51376c4f66ae9833755b34ebb5a974c7354e) Thanks [@pdlug](https://github.com/pdlug)! - Ship graph extensions for agent-driven schema induction.

  Graph extensions let a running application accept a reviewed, JSON-serializable schema proposal and commit it as a durable TypeGraph schema version without redeploying application code.

  Public API:
  - `defineGraphExtension(input)` and `validateGraphExtension(input, options?)` build and validate pure graph-extension documents.
  - `GraphExtension`, `ExtensionNodeDef`, `ExtensionEdgeDef`, `ExtensionPropertyType`, `ExtensionIndex`, version constants, and graph-extension error classes are exported for tool builders.
  - `Store.evolve(extension, { ref?, eager? })` atomically commits the merged schema with CAS and returns a fresh store carrying the graph-extension-declared kinds.
  - Graph-extension-declared kinds are reached through `getNodeCollection(kind)`, `getNodeCollectionOrThrow(kind)`, `getEdgeCollection(kind)`, and `getEdgeCollectionOrThrow(kind)`.
  - `store.introspect()` returns the merged schema (`kinds`, `edges`, `ontology`), the persisted extension document on `extension`, the soft-deprecation set on `deprecatedKinds`, and the active schema version and hash on `schemaVersion` / `schemaHash` (both `undefined` until the first commit).
  - `store.materializeIndexes()` materializes compile-time and graph-extension relational/vector indexes per deployment.
  - `store.deprecateKinds()`, `store.undeprecateKinds()`, `store.removeKinds()`, and `store.materializeRemovals()` manage graph-extension-kind lifecycle after induction.

  The v1 document subset supports nodes, edges, ontology relations, annotations, unique constraints, relational indexes, searchable string fields, and embedding fields. Restart parity is load-bearing: `createStoreWithSchema()` reads `schema_doc.extension`, recompiles the extension, and rebuilds the same Zod-bearing merged graph in a fresh process.

  `validateGraphExtension(input, { strict: true })` and `defineGraphExtension(input)` reject unknown sibling keys at every property level, surfacing the new `UNKNOWN_PROPERTY_KEY` issue. A typo like `minLenght: 5` on a string property would otherwise compile silently to a constraint-less schema; the strict path catches it at the LLM/agent trust boundary. The persistence-load path stays loose so a future v1.x.y writer's additive refinements still parse on an older v1 reader.

  Published package exports now expose declarations through a first-class `types` condition so packed-artifact consumers resolve `@nicia-ai/typegraph` and subpath types correctly.

- [#107](https://github.com/nicia-ai/typegraph/pull/107) [`e46ce46`](https://github.com/nicia-ai/typegraph/commit/e46ce46745f2d4edef0716d4136c019027dc6876) Thanks [@pdlug](https://github.com/pdlug)! - Bring compile-time indexes into `defineGraph` and `SerializedSchema` so they flow through the canonical schema document uniformly with graph-extension-declared indexes.

  ```typescript
  const personEmail = defineNodeIndex(Person, {
    fields: ["email"],
    unique: true,
  });

  const graph = defineGraph({
    id: "social",
    nodes: { Person: { type: Person } },
    edges: {},
    indexes: [personEmail],
  });

  // graph.indexes is readonly IndexDeclaration[] — JSON-serializable,
  // flows into SerializedSchema.indexes, ready for materialization.
  ```

  **Public API additions:**
  - `defineNodeIndex`, `defineEdgeIndex`, `andWhere`, `orWhere`, and `notWhere` now ship from the main `@nicia-ai/typegraph` entry point. The `@nicia-ai/typegraph/indexes` subpath remains for advanced consumers (Drizzle schema integration, `generateIndexDDL`, `toDeclaredIndex` for the profiler).
  - `defineNodeIndex` / `defineEdgeIndex` now return `NodeIndexDeclaration` / `EdgeIndexDeclaration` directly — the same JSON-serializable shape that flows through `SerializedSchema.indexes`. There is no separate "live" index value; the previous `NodeIndex` / `EdgeIndex` / `TypeGraphIndex` types have been removed from `@nicia-ai/typegraph/indexes`. Consumers using those types should switch to the declaration types.
  - `defineGraph({ ..., indexes: [...] })` accepts those declarations directly (whether produced by the typed builders or reconstructed from a stored schema document). Validated at definition time: every index must reference a registered `kind`, and index `name`s must be unique within a graph. Throws `ConfigurationError` otherwise.
  - New types: `IndexDeclaration` (discriminated union of `NodeIndexDeclaration` / `EdgeIndexDeclaration`), `IndexOrigin`.

  **`SerializedSchema.indexes` slice.** Each entry carries an `origin?: "compile-time" | "runtime"` discriminator so a graph-extension loader can route declarations through the runtime compiler. Index DDL generation (`generateIndexDDL`, the Drizzle schema factories, the profiler `toDeclaredIndex` adapter) all read from this single canonical form — no parallel paths.

  **Diffing.** `computeSchemaDiff` / `SchemaManager.getSchemaChanges` now classify index additions, removals, and modifications. All index changes are `safe`-severity: index DDL is materialized separately and never blocks schema-version commits.

  **Load-bearing canonical-form invariants** (verified by tests in `tests/property/schema-serialization.test.ts`):
  - Graphs that never declare indexes produce identical canonical-form hashes to today — adoption requires no migration.
  - The serialized slice is order-canonicalized (sorted by `name`) and treats `undefined` and `[]` as the same "no slice" form. Indexes are an unordered set keyed by name; an empty list carries no semantic meaning that an absent slice doesn't, so the hash and the diff agree on both points (reorders are a no-op, opting in with `[]` doesn't bump the hash). The in-memory `GraphDef.indexes` still preserves whatever the caller passed for introspection.
  - A populated `indexes` array bumps the hash. Round-trip (`serialize → JSON → serializedSchemaZod.parse → JSON`) is byte-identical after the canonical sort.
  - `origin: "compile-time"` is the default and is omitted from canonical form. Only `origin: "runtime"` is emitted explicitly. Absence-as-default keeps compile-only graphs hashing identically; the graph-extension loader emits the explicit `"runtime"` discriminator on extension-declared indexes.

  **Forward compatibility.** `serializedSchemaZod` parses both old (no `indexes`) and new documents, with extras-allowed (`.loose()`) on each declaration so future fields don't break older readers.

- [#112](https://github.com/nicia-ai/typegraph/pull/112) [`0eb92aa`](https://github.com/nicia-ai/typegraph/commit/0eb92aa89c23601884e9946c4c92faa30eef9d01) Thanks [@pdlug](https://github.com/pdlug)! - Add `store.materializeIndexes(options?)` — runs `CREATE INDEX` DDL for the indexes declared on a graph and tracks per-deployment status in a new `typegraph_index_materializations` table.

  ```typescript
  const [store] = await createStoreWithSchema(graph, backend);

  // Materialize all declared indexes (idempotent — second call reports
  // alreadyMaterialized for each).
  const result = await store.materializeIndexes();

  // Restrict by kind:
  await store.materializeIndexes({ kinds: ["Paper", "Author"] });

  // Halt on first failure (default is best-effort — failures are
  // recorded per-index in the result and the loop continues):
  await store.materializeIndexes({ stopOnError: true });
  ```

  ## Public API
  - `Store.materializeIndexes(options?: { kinds?: readonly string[]; stopOnError?: boolean })` — async; returns `MaterializeIndexesResult`.
  - `MaterializeIndexesResult.results: readonly MaterializeIndexesEntry[]` — one entry per declared index with `status: "created" | "alreadyMaterialized" | "failed" | "skipped"`.
  - New backend primitives on `GraphBackend`: `executeDdl(sql)`, `getIndexMaterialization(indexName)`, `recordIndexMaterialization(params)`. Bundled SQLite + Postgres backends implement all three.
  - `GenerateIndexDdlOptions.concurrent` — Postgres-only flag for `CREATE INDEX CONCURRENTLY`. SQLite ignores. Set automatically by `materializeIndexes`.

  ## Storage
  - New table `typegraph_index_materializations` (PK on `index_name` because SQL index names are physical, database-global identifiers — `graph_id` is provenance, not identity). Auto-bootstrapped via `bootstrapTables` for fresh DBs and re-run inside `materializeIndexes` for legacy DBs that pre-date this slice.
  - Per-row signature is the SHA-256 hash of `{ dialect, targetTableName, declaration }` under sorted-key serialization. Includes the physical target table because consumers can override `tableNames` and a declaration-only signature would falsely report "already materialized" after a table rename. Excludes execution flags (`CONCURRENTLY`, `IF NOT EXISTS`) — those are runtime modifiers, not shape.

  ## Concurrency + safety
  - Postgres uses `CREATE INDEX CONCURRENTLY`, so live tables never take an `AccessExclusiveLock`. The DDL runs at the top-level backend (not inside `transaction()`) because CIC cannot run inside a transaction.
  - Status-table writes use `INSERT ... ON CONFLICT DO UPDATE` so concurrent callers don't deadlock on the bookkeeping. Failed attempts preserve any prior successful `materialized_at` timestamp via `COALESCE(excluded.materialized_at, materialized_at)`.
  - Best-effort by default: per-index failures land in the result (`status: "failed"` with the captured `Error`), the loop continues, and the failure is recorded in `last_error`.
  - `IF NOT EXISTS` does not validate shape on Postgres — only that something with that name exists. Drift detection here uses TypeGraph's recorded `signature`, not PG metadata. Signature mismatch surfaces as `failed` with a `different signature` message; v1 does not auto drop+recreate.
  - Failed `CONCURRENTLY` builds leave invalid indexes (`pg_index.indisvalid = false`). v1 surfaces this as a `failed` result; the operator drops the invalid index manually before retry.

  ## Deferred follow-ups
  - **Fulltext index unification.** Fulltext remains owned by the backend fulltext strategy; relational and vector indexes flow through the unified declaration channel.
  - **Public status-reader API.** The returned `MaterializeIndexesResult` plus the table itself is enough for v1; consumers query the table directly if they need monitoring. Will add `Store.getIndexMaterializationStatus()` only if usage demands it.
  - **Auto drop+recreate on signature drift.** v1 surfaces drift; auto-cleanup is risky enough to defer.

- [#103](https://github.com/nicia-ai/typegraph/pull/103) [`0917312`](https://github.com/nicia-ai/typegraph/commit/09173127ef6fcf748ef1dbd63aa1cce33e7aea0d) Thanks [@pdlug](https://github.com/pdlug)! - Add optional `annotations` field to `defineNode` and `defineEdge` for consumer-owned per-kind structured data — UI hints, audit policy, provenance pointers, and other tooling labels that don't belong in the Zod schema.

  ```typescript
  const Incident = defineNode("Incident", {
    schema: z.object({
      title: z.string(),
      summary: z.string(),
      occurredAt: z.string().datetime(),
    }),
    annotations: {
      ui: {
        titleField: "title",
        temporalField: "occurredAt",
        icon: "alert-triangle",
      },
      audit: {
        pii: false,
        retentionDays: 365,
      },
    },
  });

  const reportedBy = defineEdge("reportedBy", {
    annotations: {
      ui: { showInTimeline: true },
    },
  });
  ```

  **Contract:**
  - TypeGraph stores and versions `annotations` but never reads, validates, or interprets keys inside the field. Consumers own the entire namespace — no reserved prefixes, no `x-typegraph` extension convention. Future library-owned per-kind state, if needed, will use a separate sibling field rather than carving out keys here.
  - Annotations are included in `SerializedSchema.{nodes,edges}[*].annotations` and contribute to schema hashing with stable sorted-key ordering. Changes surface as `safe`-severity diffs through `getSchemaChanges()` / `SchemaManager`, so reformatting the annotations object doesn't bump the version, but value or structure changes do.
  - Graphs that never set `annotations` produce identical canonical-form hashes to today — adoption requires no migration. An explicit empty object (`{}`) is a structural opt-in and bumps the hash.
  - Values must be JSON-serializable. The `KindAnnotations` type is `Readonly<Record<string, JsonValue>>`, and at runtime `defineNode` / `defineEdge` reject `bigint`, `function`, `symbol`, `undefined`, `Date`, and other class instances with a `ConfigurationError` — so accidentally-non-JSON annotations can never silently break hashing or storage round-trips.

  Closes [#102](https://github.com/nicia-ai/typegraph/issues/102).

- [#127](https://github.com/nicia-ai/typegraph/pull/127) [`8ba64bc`](https://github.com/nicia-ai/typegraph/commit/8ba64bc689b2b670c9bb2fa975e2173fc066e984) Thanks [@pdlug](https://github.com/pdlug)! - Pre-0.25.0 cleanup and performance pass across graph-extension handling, schema lifecycle flows, store materialization, backend status tracking, and query compilation. This release is marked `minor` for additive TypeScript surface changes; existing runtime behavior is intended to stay compatible.

  ## Performance and correctness
  - **`materializeIndexes`** bulk-loads index materialization status in a single round-trip via a new optional `getIndexMaterializations(statusKeys)` backend primitive (implemented for SQLite + Postgres; legacy backends fall back to per-key `Promise.all`). A graph with 30 declared indexes drops 30 sequential `SELECT`s to 1. Vector-index signature hashing now uses the actual physical embeddings table (from `backend.tableNames`) instead of the literal default — fixes false drift detection on backends with custom embeddings table names.
  - **`materializeRemovals` reconciliation watermark.** The historical-walk recovery path now persists a per-graph high-water mark (`typegraph_reconciliation_markers` table) so subsequent calls walk only versions newer than the recorded marker instead of re-walking from version 1 every time. A graph with 100 schema versions drops 100 round-trips + 100 Zod parses to 0 on steady-state calls.
  - **`materializeRemovals` cleanup uses customized table names.** The `uniques` table name is now threaded through `SqlTableNames` (was hardcoded). Backends with custom `uniques` table names get correct cleanup instead of dead writes.
  - **`Store.evolve`, `Store.removeKinds`, and `Store.deprecateKinds`** all skip the post-commit `getActiveSchema` refetch by reading the row returned from `commitSchemaVersion` directly. Saves one round-trip per call (~1ms on Postgres). The deprecate path required extending `SchemaValidationResult` (see below).
  - **`mergeGraphExtension`** now validates only the merged union, short-circuits idempotent re-evolves before the validation walk, and avoids a redundant pass over already-known extension documents.
  - **`compileGraphExtension`** now caches `compileNode` per-(kindName, document) and `buildObjectSchema` per-edge-document via `WeakMap`. Partial-overlap evolves no longer rebuild Zod schemas for unchanged kinds.
  - **`ensureSchema`** now consults a per-graph `(graph, version) → SchemaHash` `WeakMap` cache (`getSchemaHash`) before serializing the current schema; on no-change boots both the serialize and SHA-256 walk are skipped.
  - **`parseSerializedSchema`** gets a 100-entry LRU cache keyed on the raw `schema_doc` string. Multi-tenant servers re-reading the same row across stores skip the full Zod parse + JSON walk (~0.5ms per call on a 50KB schema).
  - **`Postgres dropVectorIndex`** issues per-metric `DROP INDEX` statements concurrently via `Promise.all` instead of serially.
  - **`materializeRemovals`** now also cleans up the secondary `embeddings`, `fulltext`, and `uniques` tables for removed node kinds. Previously these accumulated dead rows across remove/re-add cycles, slowly degrading vector / fulltext / uniqueness lookups.
  - **`findCompileTimeReferents`** rewritten as a one-pass inverted index. The compile-time-edge / ontology referent check during `removeKinds` drops from O(K × (E + O)) to O(K + E + O) — meaningful on large graphs with many removed kinds.

  ## API additions (additive, breaking only for `toEqual` deep-shape matchers)
  - `SchemaValidationResult.initialized` and `.migrated` now carry `committedRow: SchemaVersionRow` so callers building post-commit metadata can avoid a `getActiveSchema` round-trip. Tests that compared the result with deep-equality (`toEqual`) need to use `toMatchObject` for partial matching.
  - `SqlTableNames` (returned from `backend.tableNames`) now includes a `uniques` field. The default backends populate it; custom backends with bespoke `tableNames` need to add `uniques: "typegraph_node_uniques"` (or their own customized name) to the object literal.
  - New optional backend primitives `getReconciliationMarker(graphId)`, `setReconciliationMarker(graphId, version)`, `ensureReconciliationMarkersTable()` for the `materializeRemovals` reconciliation watermark. Custom backends without them fall back to walking from version 1 (the legacy behavior).

  ## Internal cleanup
  - New named types in `core/types.ts`: `KindEntity = "node" | "edge"`, `IndexEntity = "node" | "edge" | "vector"`, `NullCheckOp = "isNull" | "isNotNull"`. Replaces ~30 inline string-union literals across the codebase. Adding a new entity or null-check op now touches one site instead of many.
  - `IncompatibleChange.type` and `GraphExtensionIssueCode` are now `as const` arrays (`INCOMPATIBLE_CHANGE_TYPES`, `GRAPH_EXTENSION_ISSUE_CODES`) plus derived types. Tests, codegen, and runtime introspection can iterate the full set without restating it.
  - `GRAPH_EXTENSION_TOP_LEVEL_KEYS` exported from `extension-types.ts`. Single source of truth for both the strict-authoring validator (typo rejection) and the persistence Zod schema's slot list.
  - `graph-extension/validation.ts` now shares helpers for hierarchical groups, strict unknown-key checks, property finalization, and optional literal validation.
  - `graph-extension/merge.ts` now shares kind-name, empty-extension, and deduplication helpers instead of carrying parallel one-off implementations.
  - `store/materialize-shared.ts` centralizes focused status-table bootstrapping and materialization orchestration for index/removal materializers.
  - `materializeRemovals` shares pending-removal payload construction and uses one entity-iterating reconciliation loop.
  - Consolidated SHA-256-truncation helpers (`schema/serializer.ts` and `store/materialize-indexes.ts`) into a single parameterized `sha256Hex(input, byteLength?)` in `utils/hash.ts`.
  - Moved `compactUndefined` and `freezeDeep` from a graph-extension-private file into `utils/object.ts`; removed the now-empty `graph-extension/internal.ts`.
  - Replaced the duplicate JSON-pointer escape helper in `validation.ts` with the existing `encodeJsonPointerSegment` from `query/json-pointer.ts` (now exported).
  - Switched inline `JSON.stringify`-equality checks in `schema/migration.ts` to the `canonicalEqual` helper for key-order-stable diff classification.
  - `summarizeWithOverflow` generic helper unifies `summarizeIssues` and `summarizeChanges` in `graph-extension/errors.ts`.

  ## Benchmarks
  - New `pnpm bench:maintenance` (and `bench:maintenance:postgres`) entry point under `packages/benchmarks/src/maintenance-bench.ts`. Establishes baselines for `evolve`, `materializeIndexes`, and `removeKinds` so future changes to schema lifecycle and materialization flows have regression detection.

- [#126](https://github.com/nicia-ai/typegraph/pull/126) [`49a4810`](https://github.com/nicia-ai/typegraph/commit/49a481050a58cb5c7c2a9d82fe0cf673469c6dc6) Thanks [@pdlug](https://github.com/pdlug)! - Add `getNodePropsSchema` / `getEdgePropsSchema` (plus `…OrThrow` siblings) on `Store` for runtime access to the compiled Zod props schema.

  Compile-time and graph-extension kinds both store their props schema as a real `z.ZodObject` — `defineNode` / `defineEdge` for the typed surface, `compileGraphExtension` for the runtime surface — and the store validates `.create()` / `.update()` against those objects. Until now those Zod instances weren't reachable through the public API, so MCP servers, tool wrappers, and agent loops that wanted to validate inputs with the same schema as the store had to either reach into private fields or round-trip `introspect().properties` JSON Schema → Zod (lossy on refinements, formats, branded `searchable()` / `embedding()` types).

  The new accessors return the exact Zod object the store uses. Closes [#122](https://github.com/nicia-ai/typegraph/issues/122).

  ```ts
  const schema = store.getNodePropsSchemaOrThrow("Paper");
  const parsed = schema.parse(input); // same parsed output as papers.create(input)
  const json = z.toJSONSchema(schema); // for MCP tool descriptions / agent prompts
  ```

  Lookup is `Object.hasOwn`-gated, matching `getNodeCollection` / `getEdgeCollection` (no prototype-name leakage). The `OrThrow` variants throw `KindNotFoundError` on unknown kinds. Identity holds for compile-time kinds: `store.getNodePropsSchema("Person") === Person.schema`.

  These return only the props validator. Operation-level checks — uniqueness, endpoint resolution (edges validate endpoints before props), temporal validity, backend constraints — still run only through `collection.create` / `update`. Failed `parse()` throws `ZodError`; failed `create()` wraps the same underlying issues in `ValidationError`.

- [#125](https://github.com/nicia-ai/typegraph/pull/125) [`7b0dd58`](https://github.com/nicia-ai/typegraph/commit/7b0dd58425bf825e677923ba91e1db9d5a4b5fa8) Thanks [@pdlug](https://github.com/pdlug)! - Add `fromDynamic` / `traverseDynamic` / `optionalTraverseDynamic` / `toDynamic` for string-keyed query traversals over runtime-declared kinds.

  `store.query()` requires every `from` / `traverse` / `to` kind to be a compile-time literal in the graph definition, so kinds added at runtime via `defineGraphExtension` + `store.evolve` were unreachable through the typed builder — multi-hop traversals over agent-induced kinds previously needed `as any` casts or restructuring into separate `find` + manual joins.

  The new sibling methods on the existing `store.query()` builder accept arbitrary string kinds:

  ```ts
  const rows = await store
    .query()
    .from("Document", "d") // typed alias - schema known
    .traverseDynamic("taggedWith", "e") // runtime edge
    .toDynamic("Tag", "n") // runtime target
    .whereNode("d", (d) => d.title.eq("the doc")) // typed: direct accessor
    .whereNode("n", (n) => n.field("label").string().eq("research")) // dynamic: discriminator
    .select((ctx) => ({ doc: ctx.d, tag: ctx.n }))
    .execute();
  ```

  `optionalTraverseDynamic` is the LEFT-JOIN sibling — source nodes without a matching edge still surface, with the dynamic edge and target aliases as `undefined`.

  Each dynamic method validates against the registry at runtime: `KindNotFoundError` on unknown node or edge names, and `EndpointError` when a `toDynamic` target isn't a valid endpoint for the current edge / direction. So `fromDynamic("Ppaer", ...)` and `traverseDynamic("authoredBy") + toDynamic("Document", ...)` (when `authoredBy.to=[Author]`) both fail fast instead of silently producing an empty query.

  Predicate accessors on dynamic aliases use a `.field(name)` discriminator that returns a `DynamicFieldBuilder`. Type-specific predicates sit behind `.string()` / `.number()` / `.date()` / `.array()` / `.object()` / `.embedding()` — each validates against the registered Zod schema at query-build time and throws `TypeError` on mismatch. `BaseFieldAccessor` methods (`eq`, `isNull`, etc.) are available directly without a discriminator.

  Mixed queries are first-class: typed aliases keep their existing typed accessors, dynamic aliases get the `.field()` API. The conditional accessor types (`NodeAccessor<N>` / `EdgeAccessor<E>` / `SelectableNode<N>` / `SelectableEdge<E>`) branch per alias on a phantom brand carried by `DynamicNodeType` / `DynamicEdgeType`. A typed `traverse("typedEdge", "e")` followed by `.toDynamic(target, "n")` keeps `e` typed — the edge schema flows through `EdgeTypeForKey<G, EK>`, not erased to `AnyEdgeType` — so `e.role.eq(...)` works without a discriminator while only the dynamic-declared aliases go through `.field()`.

  New exported types: `DynamicNodeAccessor`, `DynamicEdgeAccessor`, `DynamicFieldBuilder`, `DynamicSelectableNode`, `DynamicSelectableEdge`, `DynamicNodeType`, `DynamicEdgeType`. The compile-time `store.query()` surface is unchanged — `store.query().from("UnknownKind", ...)` still produces a TypeScript error.

- [#117](https://github.com/nicia-ai/typegraph/pull/117) [`1e9e9b5`](https://github.com/nicia-ai/typegraph/commit/1e9e9b550c55db9cc922a41f2407045000daa474) Thanks [@pdlug](https://github.com/pdlug)! - Unify vector indexes through the same declaration channel as relational indexes. Vector indexes are auto-derived from `embedding()` brands at `defineGraph()` time and flow through `Store.materializeIndexes()` like any other index.

  ## What changed

  ```typescript
  const Document = defineNode("Document", {
    schema: z.object({
      title: z.string(),
      // Auto-derives a cosine HNSW vector index with pgvector defaults.
      embedding: embedding(384),
    }),
  });

  // Override the auto-derived defaults at the brand site.
  const Image = defineNode("Image", {
    schema: z.object({
      embedding: embedding(512, { metric: "l2", m: 32, efConstruction: 100 }),
    }),
  });

  // Opt out of automatic materialization while keeping the embedding column.
  const Manual = defineNode("Manual", {
    schema: z.object({
      embedding: embedding(384, { indexType: "none" }),
    }),
  });

  const [store] = await createStoreWithSchema(graph, backend);
  const result = await store.materializeIndexes();
  // Postgres+pgvector → status: "created"
  // SQLite (or `indexType: "none"`) → status: "skipped" with reason
  ```

  ## API additions
  - `embedding(dimensions, options?)` — `options` is the new
    `EmbeddingIndexOptions` carrying `metric`, `indexType`, HNSW `m` /
    `efConstruction`, and IVFFlat `lists`. Defaults: `cosine` /
    `hnsw` / `m=16` / `efConstruction=64` (pgvector defaults).
  - `EmbeddingMetric`, `EmbeddingIndexType`, `EmbeddingIndexOptions`,
    `ResolvedEmbeddingIndex` — exported types.
  - `getEmbeddingIndex(schema)` — read the resolved index config from
    an embedding brand.
  - `IndexDeclaration` — now a discriminated union of
    `NodeIndexDeclaration | EdgeIndexDeclaration | VectorIndexDeclaration`.
  - `RelationalIndexDeclaration` — alias for the relational subset
    (the variants `generateIndexDDL` consumes).
  - `VectorIndexDeclaration`, `VectorIndexMetric`,
    `VectorIndexImplementation`, `VectorIndexParams` — exported types.
  - `MaterializeIndexesEntry.entity` — extended to include `"vector"`.
  - `MaterializeIndexesEntry.status` — new variant `"skipped"` with a
    `reason` field. Surfaces when the backend recognizes the
    declaration but can't act on it (vector indexes against SQLite
    without `sqlite-vec`, or `indexType: "none"`).

  ## Auto-derivation

  At `defineGraph()` time, every top-level node field declared with
  `embedding()` produces one `VectorIndexDeclaration`. The declarations
  flow through `GraphDef.indexes` and `SerializedSchema.indexes` like
  relational indexes. v1 limits:
  - One vector index per (kind, fieldPath). To use a different metric
    for the same field, use a different field name or wait for v2.
  - Top-level fields only. Embeddings nested inside object properties
    are not auto-derived (pgvector's column-based indexes don't address
    sub-paths cleanly).

  Explicit `VectorIndexDeclaration` entries passed via
  `defineGraph({ indexes })` win on (kind, fieldPath) collisions, so
  consumers can override defaults without losing auto-derivation for
  other fields.

  ## Materialization dispatch

  `materializeIndexes()` reads `IndexDeclaration.entity` and dispatches:
  - `node` / `edge` → existing path: `generateIndexDDL` →
    `executeDdl`.
  - `vector` → calls `backend.createVectorIndex(params)` with the
    resolved metric, indexType, dimensions, and HNSW / IVFFlat params.

  Status tracking goes through the existing
  `typegraph_index_materializations` table; the `entity` column was
  widened to accept `"vector"`. Signature includes vector params for
  drift detection.

  ## Capability checks

  `materializeIndexes()` checks `backend.capabilities.vector?.supported`
  and `backend.capabilities.vector.indexTypes` before dispatching. When
  the backend can't handle the requested vector indexType, the entry
  reports `status: "skipped"` with a clear reason rather than silently
  returning `"created"` for a no-op.

  ## Backend interface cleanup

  Removed dead code from `GraphBackend`:
  - `createFulltextIndex?` — never called from anywhere in the store
    layer; the fulltext table's canonical index is created with the
    table itself by `bootstrapTables`.
  - `dropFulltextIndex?` — same.

  Custom backends implementing these methods will need to remove them.
  Pre-1.0 acceptable.

  ## Out of scope (still deferred)
  - **Fulltext index unification.** Fulltext stays per-strategy in v1;
    the GIN / FTS5 index is created with the fulltext table at
    `bootstrapTables` time.
  - **Multiple vector indexes per (kind, field).** v1 allows at most
    one. Use a different field name for now.

## 0.24.1

### Patch Changes

- [#99](https://github.com/nicia-ai/typegraph/pull/99) [`755df5a`](https://github.com/nicia-ai/typegraph/commit/755df5a8d8114fbc72047f436132bfe105d02823) Thanks [@pdlug](https://github.com/pdlug)! - Internal: dependency bump pass (patch/minor only — TypeScript and `@types/node` held back as separate majors).

  Notable runtime/peer-relevant moves: `nanoid` 5.1.9 → 5.1.11 (only published runtime dep); dev/peer `zod` 4.3.6 → 4.4.3, `@libsql/client` 0.17.2 → 0.17.3.

  Also drops the `export` keyword on 14 types that were never reachable through any public entry point (`src/index.ts`, `./schema`, `./indexes`, `./sqlite`, `./postgres`, etc.) and had no internal importers. These were leaked-internal types surfaced by a sensitivity change in `knip` 6.11. No symbol on the documented API surface changed; consumers importing only via the package's declared `exports` paths are unaffected.

## 0.24.0

### Minor Changes

- [#97](https://github.com/nicia-ai/typegraph/pull/97) [`8747df8`](https://github.com/nicia-ai/typegraph/commit/8747df8c003589f985e86ca654cf796fa5230e34) Thanks [@pdlug](https://github.com/pdlug)! - SQLite: implement `backend.vectorSearch`, unblocking `store.search.hybrid()` on SQLite.

  The hybrid retrieval facade has been Postgres-only since [#88](https://github.com/nicia-ai/typegraph/issues/88): SQLite shipped fulltext (`fulltextSearch`) and embedding persistence (`upsertEmbedding` / `deleteEmbedding`), but never the `vectorSearch` method that `executeHybridSearch` requires for RRF fusion. `.similarTo()` on SQLite still worked because the predicate path goes through the query compiler, not the backend facade — but anyone reaching for `store.search.hybrid()` on SQLite hit `ConfigurationError: Backend does not support vector search`.

  This release wires up the SQLite half of that contract:
  - `buildVectorSearchSqlite` issues `vec_distance_cosine` / `vec_distance_l2` against the embeddings BLOB column, mirroring the Postgres SQL shape (same WHERE / ORDER BY / score expression / minScore semantics).
  - `createSqliteBackend` exposes `vectorSearch` on the backend object whenever `hasVectorEmbeddings` is true (parallel to the existing `upsertEmbedding` gate).
  - `inner_product` is rejected — sqlite-vec has no `vec_distance_ip` function.

  ```typescript
  import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite/local";

  const { backend } = createLocalSqliteBackend(); // sqlite-vec auto-loaded
  const store = createStore(graph, backend);

  const ranked = await store.search.hybrid("Document", {
    limit: 10,
    vector: { fieldPath: "embedding", queryEmbedding },
    fulltext: { query: "climate adaptation" },
  });
  ```

  **Performance.** On the standard search-shapes bench (500 docs, 384-dim), SQLite hybrid clocks in at **0.8ms** — about 3× faster than PostgreSQL's 2.5ms on the same shape. The bench harness now measures it on both backends; the previously-blank SQLite cell in the search comparison table is filled in.

## 0.23.0

### Minor Changes

- [#95](https://github.com/nicia-ai/typegraph/pull/95) [`6f3bf30`](https://github.com/nicia-ai/typegraph/commit/6f3bf30b4ac7c51a5528e1001dc97e05146801b7) Thanks [@pdlug](https://github.com/pdlug)! - PostgreSQL: official postgres-js / Neon support, server-side prepared statements on the fast path, and a `refreshStatistics()` API.

  **Four drivers supported.** `createPostgresBackend` has always been driver-agnostic, but only `node-postgres` was covered in CI. This release adds:
  - **`drizzle-orm/postgres-js`** — full adapter + integration suite coverage (~250 tests run against both `pg` and `postgres-js` against a real PostgreSQL).
  - **`drizzle-orm/neon-serverless`** — `@neondatabase/serverless` Pool over WebSockets. Wiring smoke tests verify driver detection, fast-path routing, Date→string normalization, and capability surface; the shared code paths are exercised by the `pg` integration suite since this driver is pg-Pool-protocol-compatible.
  - **`drizzle-orm/neon-http`** — `@neondatabase/serverless` `neon(url)` over HTTP. Auto-detected so `capabilities.transactions` is set to `false` (HTTP can't hold a session); single-statement reads, writes, and migrations work normally. Smoke tests verify the detection and capability override.

  Same `createPostgresBackend(db)` entry point regardless of driver.

  ```typescript
  // postgres-js
  import postgres from "postgres";
  import { drizzle } from "drizzle-orm/postgres-js";
  const backend = createPostgresBackend(
    drizzle(postgres(process.env.DATABASE_URL)),
  );

  // Neon serverless (edge runtimes)
  import { Pool } from "@neondatabase/serverless";
  import { drizzle } from "drizzle-orm/neon-serverless";
  const backend = createPostgresBackend(
    drizzle(new Pool({ connectionString: env.NEON_DATABASE_URL })),
  );
  ```

  **On Neon HTTP vs WebSockets:** both work. The HTTP driver (`drizzle-orm/neon-http`) is best for stateless edge workloads — TypeGraph auto-disables transactions since HTTP can't hold a session, and `store.transaction(...)` falls through to non-transactional sequential execution. Use the WebSocket driver (`drizzle-orm/neon-serverless`) when you need atomic multi-statement writes.

  **~6× faster on multi-hop traversals via server-side prepared statements.** The execution adapter now uses `node-postgres`'s named prepared statements transparently — each unique compiled SQL string gets a stable counter-derived statement name (cached by SQL text), so PostgreSQL caches the plan after first execution. Combined with routing `execute()` through the fast path directly (skipping Drizzle's session wrapper), this drops the 3-hop benchmark from ~7.5ms to ~0.8ms median, putting TypeGraph-on-PostgreSQL at parity with Neo4j on every single-query and multi-hop shape we measure.

  The change is invisible to callers; existing code keeps working. postgres-js is unchanged (it handles its own preparation internally).

  **New `store.refreshStatistics()` / `backend.refreshStatistics()` API.** Call once after a large initial import or bulk backfill. Without fresh stats, the planner can pick suboptimal execution plans — on PostgreSQL this is the difference between a 0.5ms and 5ms forward traversal; on SQLite it's the difference between 0.9ms and 23ms fulltext search. Autovacuum / background statistics catch up eventually, but explicit invocation gives correct latencies immediately.

  ```typescript
  for (const batch of batches) {
    await store.nodes.Document.bulkCreate(batch);
  }
  await store.refreshStatistics();
  ```

  Implementations: SQLite runs `ANALYZE`; PostgreSQL runs `ANALYZE` on TypeGraph-managed tables only. Costs ~20ms on SQLite, ~80ms on PostgreSQL at the sizes this library is designed for.

  **Type surface changes:**
  - `GraphBackend` now requires a `refreshStatistics(): Promise<void>` method. `TransactionBackend` still excludes it (statistics refresh isn't meaningful inside a transaction). External `GraphBackend` implementations (uncommon) need to add a no-op or proper implementation.
  - `PostgresBackendOptions` adds an optional `capabilities?: Partial<BackendCapabilities>` for users who need to override capability flags (e.g., for custom HTTP-style drivers).
  - `PostgresBackendOptions` also adds `prepareStatements?: boolean` (default `true`) and `preparedStatementCacheMax?: number` (default `256`). The prepared-statement name cache is now LRU-bounded so high-cardinality SQL text doesn't grow unbounded in either the Node process or in PostgreSQL's per-session prepared-statement memory. Set `prepareStatements: false` when pooling through pgbouncer in transaction-pool mode.

  See [`backend-setup`](https://typegraph.dev/backend-setup#choosing-a-postgresql-driver) for the runtime-to-driver matrix, per-driver setup snippets, and post-bulk-load guidance.

## 0.22.0

### Minor Changes

- [#93](https://github.com/nicia-ai/typegraph/pull/93) [`1e9ae18`](https://github.com/nicia-ai/typegraph/commit/1e9ae18c0219c8168f0584b65b41a9ec2c564b60) Thanks [@pdlug](https://github.com/pdlug)! - Add `countEdges(edgeAlias)` and `countDistinctEdges(edgeAlias)` — edge-count aggregators that skip the target-node join in the count aggregate fast path.

  The default `count(targetAlias)` counts edges whose target node is currently live under the query's temporal mode, which requires joining the edges to the target node table on every aggregation. For the common "how many follow relationships does this user have?" question, that join is unnecessary work: you want to count edges, not reach through each edge to validate the target.

  ```typescript
  import { count, countEdges, field } from "@nicia-ai/typegraph";

  const result = await store
    .query()
    .from("User", "u")
    .optionalTraverse("follows", "e", { expand: "none" })
    .to("User", "target")
    .groupByNode("u")
    .aggregate({
      name: field("u", "name"),
      // Counts live edges, regardless of target-node validity.
      // Skips the typegraph_nodes join entirely — ~1.7x faster on
      // SQLite, ~1.35x on PostgreSQL at benchmark scale.
      followCount: countEdges("e"),
      // Counts edges to live targets. Keeps the target-node join
      // so the target's temporal window is honored.
      liveFollowCount: count("target"),
    })
    .execute();
  ```

  **When to use which:**
  - `count(targetAlias)` — when the semantic question is "how many of this user's follows point to a live user?" The target-node join enforces the target's `validTo` / `deleted_at` filters.
  - `countEdges(edgeAlias)` — when the semantic question is "how many follow relationships does this user have?" The edge's own temporal and deletion filters are enforced; target validity is not consulted.
  - `countDistinctEdges(edgeAlias)` — same semantics as `countEdges` but with `COUNT(DISTINCT ...)`. Useful under ontology-driven expansions where the same edge can appear multiple times in join output.

  The two can be mixed in one aggregate. When present together, the compiler keeps the target-node join but switches it to a `LEFT JOIN` with node-side filters pushed into the `ON` clause so edge counts reflect all live edges while node counts only reflect edges to live targets.

  No change to existing `count(...)` behavior. This is purely additive — code that currently uses `count("targetAlias")` continues to count live targets exactly as before.

### Patch Changes

- [#93](https://github.com/nicia-ai/typegraph/pull/93) [`1e9ae18`](https://github.com/nicia-ai/typegraph/commit/1e9ae18c0219c8168f0584b65b41a9ec2c564b60) Thanks [@pdlug](https://github.com/pdlug)! - Push `LIMIT` past `GROUP BY` in the count aggregate fast path when it's safe.

  When `groupByNode(...).aggregate({ x: count(alias) })` is paired with an optional traversal and a `.limit(n)` that doesn't depend on the aggregate (no `ORDER BY`, or an `ORDER BY` restricted to group keys), the compiler now emits the `LIMIT` inside the start CTE. The `GROUP BY` runs over `n` rows instead of the full start set — `O(limit)` grouping work instead of `O(|start|)`. When `OFFSET` is also set, it rides along with the `LIMIT` into the start CTE and the outer `SELECT` drops its own `LIMIT`/`OFFSET` so neither clause is double-applied.

  The fast path also picks `INNER JOIN` over `LEFT JOIN` for the target-node join whenever a `whereNode()` predicate applies to the target alias, so those predicates constrain every aggregate — including `countEdges(...)`. `LEFT JOIN` remains the strategy when only temporal/delete filters apply to the target, so `countEdges` and `count(target)` can coexist in one query with divergent semantics.

  No change to query semantics — aggregate counts still reflect the same `count(target)` as before, including the target node's temporal and deletion filters. No change to aggregate queries without a `LIMIT`. No change on SQLite or PostgreSQL query shapes outside the fast path.

  Measured impact: scopes down group-by work for "top-N by count"-style aggregate queries. No impact on the blog-post benchmark's full-graph aggregate (which measures the ungrouped 1,200-user case and intentionally runs without a `LIMIT`).

- [#93](https://github.com/nicia-ai/typegraph/pull/93) [`1e9ae18`](https://github.com/nicia-ai/typegraph/commit/1e9ae18c0219c8168f0584b65b41a9ec2c564b60) Thanks [@pdlug](https://github.com/pdlug)! - Fix `generateSqliteDDL` and `generatePostgresMigrationSQL` emitting `(unknown, unknown, ...)` for indexes threaded through `createSqliteTables({}, { indexes })` or `createPostgresTables({}, { indexes })`.

  The DDL generator's SQL-chunk flattener didn't handle two cases that appear inside index expression keys: Drizzle column references nested inside a SQL stream (whose `.getSQL()` wraps the column back inside a self-referential SQL object, causing the previous logic to recurse and fall through to `"unknown"`), and `StringChunk` values stored as single-element arrays (`[""]`).

  Expression indexes now emit correctly in both dialects, e.g.

  ```sql
  CREATE INDEX IF NOT EXISTS "idx_tg_node_user_city_cov_name_…" ON "typegraph_nodes"
    ("graph_id", "kind", (json_extract("props", '$."city"')), (json_extract("props", '$."name"')));
  ```

  Added a regression test in `tests/indexes.test.ts` asserting that DDL from `createSqliteTables`/`createPostgresTables` never contains `(unknown` and includes the expected column and `json_extract` / `ARRAY['…']` expressions.

- [#93](https://github.com/nicia-ai/typegraph/pull/93) [`1e9ae18`](https://github.com/nicia-ai/typegraph/commit/1e9ae18c0219c8168f0584b65b41a9ec2c564b60) Thanks [@pdlug](https://github.com/pdlug)! - Emit `NOT MATERIALIZED` on PostgreSQL traversal and start CTEs so the planner can inline them and see their inner row statistics.

  PostgreSQL defaults to materializing any CTE referenced more than once. TypeGraph's traversal compilation references each CTE twice — once from the next hop's join, once from the final SELECT — which triggers materialization under the default rules. Materialized CTEs have opaque statistics to the planner, causing poor join orderings and wildly off row estimates on multi-hop queries over larger graphs.

  Introduces a `emitNotMaterializedHint` dialect capability (`true` for PostgreSQL, `false` for SQLite, which ignores the hint entirely) and threads it through the start-CTE and traversal-CTE emitters. The hint matches what an expert would write by hand for the same query shape.

  Impact on the TypeGraph benchmark suite:
  - Multi-hop traversal plans no longer carry opaque materializations, so the planner picks index-scan orderings appropriate to the starting row's selectivity.
  - No visible change on SQLite (the hint is not emitted).
  - Guards against regressions on larger graphs where materialized CTE plans degenerate into cross-product-plus-filter.

- [#93](https://github.com/nicia-ai/typegraph/pull/93) [`1e9ae18`](https://github.com/nicia-ai/typegraph/commit/1e9ae18c0219c8168f0584b65b41a9ec2c564b60) Thanks [@pdlug](https://github.com/pdlug)! - Persist vector embeddings on the SQLite backend when sqlite-vec is loaded.

  Previously, `store.nodes.X.create({ ..., embedding: [...] })` on SQLite validated the embedding and inserted the node, but the embedding itself was silently dropped — the SQLite backend didn't implement `upsertEmbedding`/`deleteEmbedding`, so the store's embedding-sync path quietly no-op'd. Vector predicates like `d.embedding.similarTo(q, 20, { metric: "cosine" })` then ran against an empty `typegraph_node_embeddings` table and returned zero rows without error.

  This release wires up both methods on the SQLite backend. They encode embeddings to `vec_f32('[...]')` BLOBs on write and rely on sqlite-vec at query time — same storage shape the existing `.similarTo()` compilation already targets. Activation is opt-in via a new `hasVectorEmbeddings` option on `createSqliteBackend` so callers that haven't loaded sqlite-vec don't hit `no such function: vec_f32` at write time. `createLocalSqliteBackend` best-effort-loads sqlite-vec at startup and flips the option automatically, so the common local setup works without configuration.

  ```typescript
  // Local backend: sqlite-vec is loaded automatically when installed.
  const { backend } = createLocalSqliteBackend();

  // BYO drizzle connection: pass hasVectorEmbeddings after loading sqlite-vec.
  import sqliteVec from "sqlite-vec";
  sqliteVec.load(sqlite);
  const backend = createSqliteBackend(drizzle(sqlite), {
    tables,
    hasVectorEmbeddings: true,
  });
  ```

  `getEmbedding` and the hybrid-search facade (`store.search.hybrid(...)`) remain PostgreSQL-only — decoding the raw BLOB back to `number[]` via `vec_to_json` and exposing a hybrid-search backend method are tracked separately.

## 0.21.0

### Minor Changes

- [#88](https://github.com/nicia-ai/typegraph/pull/88) [`6f681d5`](https://github.com/nicia-ai/typegraph/commit/6f681d59f16ef7d7651627999cce6cada01d024e) Thanks [@pdlug](https://github.com/pdlug)! - Add fulltext search and hybrid (vector + fulltext) retrieval. Declare `searchable()` string fields on any node schema and TypeGraph keeps a native FTS index in sync — `tsvector` + GIN on PostgreSQL, FTS5 on SQLite. Query it through a node-level `n.$fulltext.matches()` predicate that composes with metadata filters, graph traversal, and vector similarity in one SQL statement.

  ```typescript
  import { defineNode, searchable, embedding } from "@nicia-ai/typegraph";

  const Document = defineNode("Document", {
    schema: z.object({
      title: searchable({ language: "english" }),
      body: searchable({ language: "english" }),
      tenantId: z.string(),
      embedding: embedding(1536),
    }),
  });

  // Fulltext + metadata filter in a single query
  const results = await store
    .query()
    .from("Document", "d")
    .whereNode("d", (d) =>
      d.$fulltext.matches("climate change", 20).and(d.tenantId.eq(tenant)),
    )
    .select((ctx) => ctx.d)
    .execute();

  // Hybrid: vector + fulltext fused with Reciprocal Rank Fusion at the SQL layer
  const hybrid = await store
    .query()
    .from("Document", "d")
    .whereNode("d", (d) =>
      d.$fulltext
        .matches("climate", 50)
        .and(d.embedding.similarTo(queryVector, 50))
        .and(d.tenantId.eq(tenant)),
    )
    .select((ctx) => ctx.d)
    .limit(10)
    .execute();

  // Store-level helper with tunable RRF weights and snippets
  const tuned = await store.search.hybrid("Document", {
    limit: 10,
    vector: { fieldPath: "embedding", queryEmbedding: queryVector },
    fulltext: { query: "climate change", includeSnippets: true },
    fusion: { method: "rrf", k: 60, weights: { vector: 1, fulltext: 1.5 } },
  });
  ```

  Query modes cover `websearch` (Google-style syntax — default), `phrase`, `plain`, and `raw` (dialect-native tsquery / FTS5 MATCH). Highlighting via `ts_headline` / `snippet()` is opt-in per query. No extensions required: Postgres uses the built-in `tsvector` + GIN (works on every managed provider); SQLite uses FTS5 which is statically linked into the standard `better-sqlite3` / `libsql` / `bun:sqlite` distributions. See `/fulltext-search` for the full guide.

  ### Added
  - `n.$fulltext` — node-level fulltext accessor; `.matches(query, k?, options?)` composes against the combined `searchable()` content. `$fulltext` is exposed on every `NodeAccessor`; a runtime guard throws a clear error if the node kind has no `searchable()` fields. `k` defaults to 50.
  - `store.search` facade — `store.search.fulltext()`, `store.search.hybrid()`, and `store.search.rebuildFulltext()` grouped under one namespace. Lazy-initialized and cached on first access.
  - `FulltextSearchHit`, `VectorSearchHit`, and `HybridSearchHit` are generic over the node type (`FulltextSearchHit<N = Node>`). `store.search.fulltext("Document", ...)` returns hits with `hit.node` narrowed to the Document node shape — no cast required.
  - `backend.upsertFulltextBatch` + `backend.deleteFulltextBatch` — symmetric batched fulltext primitives. Homogeneous batch shape, duplicate-nodeId dedupe last-write-wins, per-row fallback when unset.
  - `store.search.rebuildFulltext(nodeKind?, { pageSize?, maxSkippedIds? })` — rebuilds the fulltext index from existing node data using keyset pagination on `id` (stable under shared timestamps and light concurrent writes). Transacts per page; cleans stale rows for soft-deleted nodes; validates `pageSize` as a positive integer; counts corrupt / non-object props as `skipped` and surfaces offending IDs via `skippedIds` without aborting. `maxSkippedIds` (default 10,000) lets operators investigating systemic corruption collect the full list. Concurrent hard-deletes between pages may be missed — document as maintenance operation.
  - Keyset pagination on `findNodesByKind` via new `{ orderBy, after }` params.
  - `QueryBuilder.fuseWith({ k?, weights? })` — tunable RRF on the query-builder path. Flat `HybridFusionOptions` shape, identical to `store.search.hybrid`'s `fusion` option. Throws at compile time if the query lacks either a `.similarTo()` or `n.$fulltext.matches()`. Shares its validator with `store.search.hybrid({ fusion })` so `method`, `k`, and per-source weights are checked identically on both paths.
  - `FulltextStrategy` — pluggable abstraction (exported from the top-level entry) that owns the **entire** SQL pipeline for a dialect's fulltext support: DDL, upsert (single + batch), delete (single + batch), MATCH condition, rank expression, and snippet expression. Ships `tsvectorStrategy` (Postgres built-in `tsvector`) and `fts5Strategy` (SQLite FTS5); dialect adapters expose `fulltext: FulltextStrategy | undefined`. Alternate Postgres stacks (pg_trgm, ParadeDB / pg_search, pgroonga) choose their own column layout, index type, and projection — TypeGraph's operation layer just delegates to the active strategy. Strategies declare prefix-query support explicitly via `FulltextStrategy.supportsPrefix`, so capability discovery stays correct for strategies that support prefix matching via dedicated syntax without advertising raw-mode pass-through.
  - Backend-level fulltext strategy override: `createPostgresBackend(db, { fulltext })` and `createSqliteBackend(db, { fulltext })` accept a `FulltextStrategy` that takes precedence over the dialect default. Threaded through to compiler passes, backend-direct search SQL, all write SQL, DDL generation, and capability discovery — so a ParadeDB-backed Postgres `store.search.hybrid()` fuses the same way a tsvector-backed one does, without any call-site changes.
  - Option validation: `store.search.fulltext` and `store.search.hybrid` validate caller options against the active `FulltextStrategy` (falling back to `BackendCapabilities.fulltext.{phraseQueries, highlighting, languages}` when no strategy is attached). A `mode` outside `strategy.supportedModes` throws, `includeSnippets: true` on a strategy whose `supportsSnippets` is false throws, and a per-query `language` override on a strategy whose `supportsLanguageOverride` is false (e.g. SQLite FTS5) throws. Advisory warning for unknown languages on strategies that honor overrides. `$fulltext.matches()` is validated against the dialect strategy's `supportedModes` at compile time.
  - One-time `console.warn` when a node kind has multiple `searchable()` fields with conflicting `language` values. The first field's language wins on the stored row; the warning makes the silent collapse visible so users know to split multilingual content across dedicated node kinds.
  - Snippet highlighting uses `<mark>…</mark>` consistently across both shipped strategies (`ts_headline` on Postgres, `snippet()` on SQLite). One stylesheet applies everywhere.
  - `FulltextSearchResult.score` is always `number`. The Postgres adapter coerces `numeric`-as-string driver returns at the backend boundary so downstream code never sees a union type.
  - Hybrid SQL emitter uses a deterministic `COALESCE(fulltext.node_id, embeddings.node_id) ASC` tiebreak, matching the JS-side `localeCompare(nodeId)` tiebreak used by `store.search.hybrid` — both hybrid paths produce identical top-k under RRF score ties.
  - Postgres fulltext table schema: `language` is `regconfig` (not `TEXT`) and `tsv` is a `GENERATED ALWAYS AS (to_tsvector("language", "content")) STORED` column. Postgres owns the `content / language → tsv` invariant; the strategy's write SQL doesn't recompute `tsv` inline. The `content` column is populated verbatim, and the per-query `language` override path still accepts a text parameter (cast to `regconfig` at query time). SQLite's FTS5 virtual table is unchanged.

  ### Changed
  - **`defineNode()` / `defineEdge()` reject `$`-prefixed property names.** The `$` namespace is reserved for node-level accessors (starting with `$fulltext`). A `ConfigurationError` is raised at graph-definition time instead of silently shadowing user fields at query time. Rename any such fields before upgrading.
  - **`findNodesByKind` offset pagination now has a deterministic tiebreaker** (`ORDER BY created_at DESC, id DESC`). Row order was previously under-specified when `created_at` values collided; callers that happened to rely on an implementation-dependent order may see different tie-breaking.

## 0.20.0

### Minor Changes

- [#85](https://github.com/nicia-ai/typegraph/pull/85) [`12055d0`](https://github.com/nicia-ai/typegraph/commit/12055d053b22cfadd1439c9a667307fae77af6a2) Thanks [@pdlug](https://github.com/pdlug)! - Add Tier 1 graph algorithms on `store.algorithms.*`: `shortestPath`, `reachable`, `canReach`, `neighbors`, and `degree`.

  ```typescript
  // Find the shortest path through a set of edge kinds
  const path = await store.algorithms.shortestPath(alice, bob, {
    edges: ["knows"],
    maxHops: 6,
  });

  // Enumerate reachable nodes within a depth bound
  const reachable = await store.algorithms.reachable(alice, {
    edges: ["knows"],
    maxHops: 3,
  });

  // Fast existence check
  const connected = await store.algorithms.canReach(alice, bob, {
    edges: ["knows"],
  });

  // k-hop neighborhood (source always excluded)
  const twoHop = await store.algorithms.neighbors(alice, {
    edges: ["knows"],
    depth: 2,
  });

  // Count incident edges
  const total = await store.algorithms.degree(alice, { edges: ["knows"] });
  ```

  All traversal algorithms compile to a single recursive-CTE query and share the dialect primitives used by `.recursive()` and `store.subgraph()`, so SQLite and PostgreSQL yield identical semantics. Node arguments accept either a raw ID string or any object with an `id` field — `Node`, `NodeRef`, and the lightweight records returned by the algorithms themselves all work. See `/graph-algorithms` for the full reference.

- [#85](https://github.com/nicia-ai/typegraph/pull/85) [`12055d0`](https://github.com/nicia-ai/typegraph/commit/12055d053b22cfadd1439c9a667307fae77af6a2) Thanks [@pdlug](https://github.com/pdlug)! - Graph algorithms (`store.algorithms.*`) and `store.subgraph()` now honor the store's temporal model.

  **New:** Every algorithm and `store.subgraph()` accept `temporalMode` and `asOf` options, matching the shape already used by `store.query()` and collection reads. When neither is supplied, the resolved mode falls back to `graph.defaults.temporalMode` (typically `"current"`).

  ```typescript
  // Snapshot at a point in time
  await store.algorithms.shortestPath(alice, bob, {
    edges: ["knows"],
    temporalMode: "asOf",
    asOf: "2023-01-15T00:00:00Z",
  });

  await store.subgraph(rootId, {
    edges: ["has_task"],
    temporalMode: "includeEnded",
  });
  ```

  The filter applies to both nodes and edges along the traversal, is orthogonal to `cyclePolicy`, and is honored by the shortest-path self-path short-circuit.

  **BREAKING:** `store.subgraph()` previously ignored graph temporal settings and filtered only by `deleted_at IS NULL` (equivalent to `"includeEnded"`). It now defaults to `graph.defaults.temporalMode`. Callers that relied on walking through validity-ended rows must pass `temporalMode: "includeEnded"` explicitly. Soft-delete filtering is unchanged under the default `"current"` mode, so most callers see no difference.

### Patch Changes

- [#87](https://github.com/nicia-ai/typegraph/pull/87) [`f52bba6`](https://github.com/nicia-ai/typegraph/commit/f52bba63befe8111d13d04cfb9659371f7061625) Thanks [@pdlug](https://github.com/pdlug)! - Fix SQLite temporal filter timestamp format in graph algorithms and subgraph.

  `buildReachableCte`, `resolveTemporalFilter`, and `fetchSubgraphEdges` compiled
  temporal filters without passing `dialect.currentTimestamp()`, so on SQLite they
  fell back to raw `CURRENT_TIMESTAMP` (`YYYY-MM-DD HH:MM:SS`). Stored
  `valid_from` / `valid_to` use ISO-8601 (`YYYY-MM-DDTHH:MM:SS.sssZ`), and because
  `T` sorts above space, same-day ISO timestamps compare incorrectly against raw
  `CURRENT_TIMESTAMP`. Under `temporalMode: "current"` this caused
  `reachable` / `canReach` / `neighbors` / `shortestPath` / `degree` and the
  `subgraph` edge hydration to misclassify rows whose `valid_from` or `valid_to`
  fell on today's date, disagreeing with `store.query()` and collection reads.

  All three call sites now inject the dialect-specific current timestamp
  (`strftime('%Y-%m-%dT%H:%M:%fZ','now')` on SQLite, `NOW()` on PostgreSQL),
  matching the query compiler.

## 0.19.0

### Minor Changes

- [#83](https://github.com/nicia-ai/typegraph/pull/83) [`206f464`](https://github.com/nicia-ai/typegraph/commit/206f46467342eee6a060c83e057bbf1befb31c1a) Thanks [@pdlug](https://github.com/pdlug)! - **BREAKING:** `store.subgraph()` now returns an indexed result instead of flat arrays.

  The result shape changes from `{ nodes: Node[], edges: Edge[] }` to:

  ```typescript
  {
    root: Node | undefined;
    nodes: ReadonlyMap<string, Node>;
    adjacency: ReadonlyMap<string, ReadonlyMap<EdgeKind, Edge[]>>;
    reverseAdjacency: ReadonlyMap<string, ReadonlyMap<EdgeKind, Edge[]>>;
  }
  ```

  This eliminates the indexing boilerplate every consumer had to write before traversing the subgraph. Nodes are keyed by ID for O(1) lookup, and edges are organized into forward/reverse adjacency maps keyed by `nodeId → edgeKind`.

  Migration:
  - `result.nodes` is now a `Map` — use `.size` instead of `.length`, `.values()` instead of direct iteration, `.has(id)` / `.get(id)` instead of `.find()`
  - `result.edges` is removed — access edges via `result.adjacency.get(fromId)?.get(edgeKind)` or `result.reverseAdjacency.get(toId)?.get(edgeKind)`
  - `result.root` provides the root node directly (no lookup needed)

## 0.18.0

### Minor Changes

- [#80](https://github.com/nicia-ai/typegraph/pull/80) [`0845fa9`](https://github.com/nicia-ai/typegraph/commit/0845fa92a653ed107057cf350414e13745fff8d8) Thanks [@pdlug](https://github.com/pdlug)! - Add first-class libsql backend at `@nicia-ai/typegraph/sqlite/libsql`

  ### New convenience export

  `createLibsqlBackend(client, options?)` wraps `@libsql/client` with automatic DDL
  execution and correct async execution profile. The caller retains ownership of the
  client, enabling shared-driver setups. Works with local files, in-memory databases,
  and remote Turso URLs.

  ```typescript
  import { createClient } from "@libsql/client";
  import { createLibsqlBackend } from "@nicia-ai/typegraph/sqlite/libsql";

  const client = createClient({ url: "file:app.db" });
  const { backend, db } = await createLibsqlBackend(client);
  const store = createStore(graph, backend);
  ```

  ### Bug fixes for async SQLite drivers
  - **`db.get()` crash on empty results** — switched to `db.all()[0]` to work around
    Drizzle's `normalizeRow` crash when libsql returns no rows
    ([drizzle-team/drizzle-orm#1049](https://github.com/drizzle-team/drizzle-orm/issues/1049))
  - **`instanceof Promise` check fails for Drizzle thenables** — all SQLite exec helpers
    now use unconditional `await` since Drizzle returns `SQLiteRaw` objects that are
    thenable but not `Promise` instances
    ([drizzle-team/drizzle-orm#2275](https://github.com/drizzle-team/drizzle-orm/issues/2275))

  ### Internal improvements
  - Extracted `wrapWithManagedClose()` helper for idempotent backend close with teardown
  - Shared adapter and integration test suites now accept async backend factories
  - libsql backend runs the full shared test suite (214 tests)

## 0.17.0

### Minor Changes

- [#77](https://github.com/nicia-ai/typegraph/pull/77) [`b9fc057`](https://github.com/nicia-ai/typegraph/commit/b9fc057e0dd62bd0f059bb78a20d18d91b1b87be) Thanks [@pdlug](https://github.com/pdlug)! - feat: support orderBy on edge properties in query builder

  The `orderBy` method now accepts edge aliases in addition to node aliases, allowing results to be ordered by properties on traversed edges. This eliminates the need to denormalize ordering fields onto nodes or sort in memory.

  ```typescript
  store
    .query()
    .from("Person", "p")
    .traverse("worksAt", "e")
    .to("Company", "c")
    .orderBy("e", "salary", "asc") // order by edge property
    .select((ctx) => ({ name: ctx.p.name, salary: ctx.e.salary }))
    .execute();
  ```

  Also fixes CTE alias resolution for edge aliases in `groupBy` and vector order-by compilation paths.

  Closes [#76](https://github.com/nicia-ai/typegraph/issues/76)

## 0.16.2

### Patch Changes

- [#73](https://github.com/nicia-ai/typegraph/pull/73) [`1c95d8e`](https://github.com/nicia-ai/typegraph/commit/1c95d8ec641442cecb38e00fab4c6d10eb162c2c) Thanks [@pdlug](https://github.com/pdlug)! - fix: dispose serialized execution queue on backend close to prevent unhandled rejections

  When the SQLite backend's underlying database is destroyed while operations are still queued (e.g., during Cloudflare Workers test teardown), the serialized execution queue now properly disposes pending promises. Calling `backend.close()` signals the queue to suppress errors from in-flight tasks and reject new operations with `BackendDisposedError`.

  Fixes [#72](https://github.com/nicia-ai/typegraph/issues/72)

## 0.16.1

### Patch Changes

- [#70](https://github.com/nicia-ai/typegraph/pull/70) [`cebf681`](https://github.com/nicia-ai/typegraph/commit/cebf681c76820db9d63c29f2eb64ed92b1eb3ad5) Thanks [@pdlug](https://github.com/pdlug)! - Widen ID parameters on `DynamicNodeCollection` and `DynamicEdgeCollection` to accept plain `string` instead of branded `NodeId`/`EdgeId` types, removing the need for casts when using the dynamic collection API with IDs from edge metadata, snapshots, or external input.

## 0.16.0

### Minor Changes

- [#66](https://github.com/nicia-ai/typegraph/pull/66) [`2f241a9`](https://github.com/nicia-ai/typegraph/commit/2f241a98fc6ec78702bcaa609e1fce9b5a1ae4f4) Thanks [@pdlug](https://github.com/pdlug)! - Add `store.getNodeCollection(kind)` and `store.getEdgeCollection(kind)` methods for runtime string-keyed collection access. Returns the full collection API with widened generics (`DynamicNodeCollection` / `DynamicEdgeCollection`), or `undefined` if the kind is not registered. Eliminates the need for `Reflect.get(store.nodes, kind) as SomeType` patterns when iterating kinds, resolving nodes from edge metadata, or building generic graph tooling like snapshots and summaries.

## 0.15.0

### Minor Changes

- [#63](https://github.com/nicia-ai/typegraph/pull/63) [`546a7eb`](https://github.com/nicia-ai/typegraph/commit/546a7eb3693141fa8ad236c9aad3333abf635893) Thanks [@pdlug](https://github.com/pdlug)! - `createStoreWithSchema()` now auto-creates base tables on a fresh database. Previously, calling it against a database without pre-existing TypeGraph tables (e.g. a new Cloudflare Durable Object) would throw a raw "no such table" error. The function now detects missing tables and bootstraps them automatically via the new optional `bootstrapTables` method on `GraphBackend`. Both SQLite and PostgreSQL backends implement this method. `createStore()` remains unchanged for users who manage DDL manually.

- [#64](https://github.com/nicia-ai/typegraph/pull/64) [`6b84b42`](https://github.com/nicia-ai/typegraph/commit/6b84b42bd9e626ca01f48d8a5bd3c18c5bfee80d) Thanks [@pdlug](https://github.com/pdlug)! - Add `StoreProjection<G, N, E>` utility type for typing reusable helpers that work across graphs sharing a common subgraph. The type projects a store's collection surface onto a subset of node and edge keys, with node constraint names erased so that graphs registering the same node types with different unique constraints remain cross-assignable. Both `Store<G>` and `TransactionContext<G>` are structurally assignable to any `StoreProjection` whose keys are a subset of `G`. Also exports `GraphNodeCollections<G>` and `GraphEdgeCollections<G>` shared mapped types.

### Patch Changes

- [#59](https://github.com/nicia-ai/typegraph/pull/59) [`36742a1`](https://github.com/nicia-ai/typegraph/commit/36742a11f47b2e1903c13ce6abce3e72285f0dbf) Thanks [@pdlug](https://github.com/pdlug)! - Reject empty `fields` arrays at the type level in `defineNodeIndex` and `defineEdgeIndex`. Previously, passing `fields: []` was accepted by TypeScript but threw at runtime. The `fields` property now requires a non-empty tuple, surfacing the error at compile time.

- [#60](https://github.com/nicia-ai/typegraph/pull/60) [`dca5aba`](https://github.com/nicia-ai/typegraph/commit/dca5abad98cdb4df0ca546796f89c6470bdcf680) Thanks [@pdlug](https://github.com/pdlug)! - Export `SchemaValidationResult` and `SchemaManagerOptions` types from the root package entry point so users can type the return value of `createStoreWithSchema()` without reaching into internal subpaths.

## 0.14.0

### Minor Changes

- [#54](https://github.com/nicia-ai/typegraph/pull/54) [`bf6997a`](https://github.com/nicia-ai/typegraph/commit/bf6997afd5889556961977f45bdc9c8d38021902) Thanks [@pdlug](https://github.com/pdlug)! - ### Breaking: default recursive traversal depth lowered from 100 to 10

  Unbounded `.recursive()` traversals are now capped at 10 hops instead of 100. Graphs with branching factor _B_ produce O(_B_^depth) rows before cycle detection can prune them — the previous default of 100 made exponential blowup easy to trigger accidentally.

  If your traversals relied on the implicit 100-hop cap, add an explicit `.maxHops(100)` call. The `MAX_EXPLICIT_RECURSIVE_DEPTH` ceiling (1000) is unchanged.

  ### Schema parse validation

  Serialized schema documents read from the database are now validated against a Zod schema at the parse boundary. Malformed, truncated, or incompatible schema documents will throw a `DatabaseOperationError` with path-level detail instead of propagating silently. Enum fields (`temporalMode`, `cardinality`, `deleteBehavior`, etc.) are validated against the known literal unions.

  ### Type safety improvements
  - Added `useUnknownInCatchVariables`, `noFallthroughCasesInSwitch`, and `noImplicitReturns` to tsconfig
  - Drizzle row mappers now use runtime type checks (`asString`/`asNumber`) instead of unsafe `as` casts
  - `NodeMeta` and `EdgeMeta` are now derived from row types via mapped types
  - All non-null assertions (`!`) eliminated from source code
  - Hardcoded constants extracted to shared `constants.ts`
  - Duplicate `fnv1aBase36` function consolidated into `utils/hash.ts`

## 0.13.0

### Minor Changes

- [#52](https://github.com/nicia-ai/typegraph/pull/52) [`1e3da4a`](https://github.com/nicia-ai/typegraph/commit/1e3da4aa814f3baf67a0cb54c9c753508eecf0f0) Thanks [@pdlug](https://github.com/pdlug)! - Add `batchFindFrom`, `batchFindTo`, and `batchFindByEndpoints` to edge collections for use with `store.batch()`.

  Edge collection lookup methods (`findFrom`, `findTo`, `findByEndpoints`) execute immediately and cannot participate in `store.batch()`. The new `batchFind*` variants return a `BatchableQuery` instead, enabling edge lookups to share a single transactional connection alongside fluent queries.

  ```typescript
  const [skills, employer, colleague] = await store.batch(
    store.edges.hasSkill.batchFindFrom(alice),
    store.edges.worksAt.batchFindFrom(alice),
    store.edges.knows.batchFindByEndpoints(alice, bob),
  );
  ```

  - **`batchFindFrom(from)`** — deferred variant of `findFrom`
  - **`batchFindTo(to)`** — deferred variant of `findTo`
  - **`batchFindByEndpoints(from, to, options?)`** — deferred variant of `findByEndpoints`, returns 0-or-1 element array

  All three preserve the same endpoint type constraints as their immediate counterparts.

  Closes [#51](https://github.com/nicia-ai/typegraph/issues/51).

## 0.12.0

### Minor Changes

- [#50](https://github.com/nicia-ai/typegraph/pull/50) [`a59416d`](https://github.com/nicia-ai/typegraph/commit/a59416d8cbc641fd7611ee5d5b0fb115aea59450) Thanks [@pdlug](https://github.com/pdlug)! - Add `store.batch()` for executing multiple queries over a single connection with snapshot consistency.
  - **Single connection**: Acquires one connection via an implicit transaction, eliminating pool pressure from parallel `Promise.all` patterns (N connections → 1).
  - **Snapshot consistency**: All queries see the same database state — no interleaved writes between results.
  - **Typed tuple results**: Returns a mapped tuple preserving each query's independent result type, projection, filtering, sorting, and pagination.
  - **`BatchableQuery` interface**: Satisfied by both `ExecutableQuery` (from `.select()`) and `UnionableQuery` (from set operations like `.union()`, `.intersect()`). Exposes `executeOn()` for backend-delegated execution.
  - **Minimum 2 queries**: Enforced at the type level — single queries should use `.execute()` directly.

  ```typescript
  const [people, companies] = await store.batch(
    store
      .query()
      .from("Person", "p")
      .select((ctx) => ({ id: ctx.p.id, name: ctx.p.name })),
    store
      .query()
      .from("Company", "c")
      .select((ctx) => ({ id: ctx.c.id, name: ctx.c.name }))
      .orderBy("c", "name", "asc")
      .limit(5),
  );
  // people:    readonly { id: string; name: string }[]
  // companies: readonly { id: string; name: string }[]
  ```

  Closes [#47](https://github.com/nicia-ai/typegraph/issues/47).

- [#48](https://github.com/nicia-ai/typegraph/pull/48) [`753d9eb`](https://github.com/nicia-ai/typegraph/commit/753d9ebc6aa02f0f01bc52abc1de255b2d1bbd91) Thanks [@pdlug](https://github.com/pdlug)! - Add field-level projection to `store.subgraph()` via a declarative `project` option.
  - **Declarative field selection**: Specify which properties to keep per node/edge kind. Projected nodes always retain `kind` and `id`; projected edges always retain structural endpoint fields. Kinds omitted from `project` remain fully hydrated.
  - **SQL-level extraction**: Projected property fields are extracted via `json_extract()` / JSONB path expressions directly in the query, avoiding full `props` blob transfer for projected kinds.
  - **All-or-nothing metadata**: Include `"meta"` in the field list for the full metadata object, or omit it entirely. No partial metadata selection — the struct is small enough that subsetting adds complexity without meaningful savings.
  - **`defineSubgraphProject()` helper**: Curried identity function that preserves literal types for reusable projection configs. Without it, storing a projection in a variable widens field arrays to `string[]`, defeating compile-time narrowing.
  - **Type-safe results**: Result types narrow per-kind based on the projection — accessing omitted fields is a compile-time error. Works through both inline literals and `defineSubgraphProject()`.

  ```typescript
  const result = await store.subgraph(rootId, {
    edges: ["has_task", "uses_skill"],
    maxDepth: 2,
    project: {
      nodes: {
        Task: ["title", "meta"],
        Skill: ["name"],
      },
      edges: {
        uses_skill: ["priority"],
      },
    },
  });
  // result.nodes — Task has { kind, id, title, meta }; Skill has { kind, id, name }
  // result.edges — uses_skill has { id, kind, fromKind, fromId, toKind, toId, priority }
  ```

  Closes [#46](https://github.com/nicia-ai/typegraph/issues/46) (alternative implementation — declarative arrays instead of callbacks).

## 0.11.1

### Patch Changes

- [#41](https://github.com/nicia-ai/typegraph/pull/41) [`68d5432`](https://github.com/nicia-ai/typegraph/commit/68d5432f830978bc05f888134ed1a69644ed97b9) Thanks [@pdlug](https://github.com/pdlug)! - Fix `.paginate()` dropping `id` from selective query results and `orderBy()` mishandling system fields.
  - **Fix silent data loss in `.paginate()` + `.select()`**: `FieldAccessTracker.record()` no longer allows a system field (`id`, `kind`) to be downgraded to a props field, which caused the SQL projection to extract from `props->>'id'` (nonexistent) instead of the `id` column.
  - **Fix `orderBy()` for system fields**: `orderBy("alias", "id")` now emits `ORDER BY cte.alias_id` instead of `ORDER BY json_extract(cte.alias_props, '$.id')`.
  - **Add `gt`/`gte`/`lt`/`lte` to `StringFieldAccessor`**: Enables keyset cursor pagination via `whereNode("a", (a) => a.id.lt(cursor))`.

  Fixes [#40](https://github.com/nicia-ai/typegraph/issues/40).

## 0.11.0

### Minor Changes

- [#38](https://github.com/nicia-ai/typegraph/pull/38) [`e26e4a5`](https://github.com/nicia-ai/typegraph/commit/e26e4a5282d9e59ab517a68dede37c38bea2a1e9) Thanks [@pdlug](https://github.com/pdlug)! - Add `createFromRecord()` and `upsertByIdFromRecord()` to `NodeCollection`.

  These methods accept `Record<string, unknown>` instead of `z.input<N["schema"]>`, providing an escape hatch for dynamic-data scenarios (changesets, migrations, imports) where the data shape is determined at runtime. Runtime Zod validation is unchanged — only the compile-time type gate is relaxed. The return type remains fully typed as `Node<N>`.

  Closes [#37](https://github.com/nicia-ai/typegraph/issues/37).

## 0.10.0

### Minor Changes

- [#33](https://github.com/nicia-ai/typegraph/pull/33) [`da14806`](https://github.com/nicia-ai/typegraph/commit/da14806b665418c7761b5db37641b23eb2914304) Thanks [@pdlug](https://github.com/pdlug)! - Add `store.subgraph()` for typed BFS neighborhood extraction from a root node.

  Given a root node ID, traverses specified edge kinds using a recursive CTE and returns all reachable nodes and connecting edges as fully typed discriminated unions.

  **Options:**
  - `edges` — edge kinds to traverse (required)
  - `maxDepth` — maximum traversal depth (default: 10)
  - `direction` — `"out"` (default) or `"both"` for undirected traversal
  - `includeKinds` — filter returned nodes to specific kinds (traversal still follows all reachable nodes)
  - `excludeRoot` — omit the root node from results
  - `cyclePolicy` — cycle detection strategy (default: `"prevent"`)

  **Type utilities exported:**
  - `AnyNode<G>` / `AnyEdge<G>` — discriminated unions of all node/edge runtime types in a graph
  - `SubsetNode<G, K>` / `SubsetEdge<G, K>` — narrowed unions for a subset of kinds
  - `SubgraphOptions<G, EK, NK>` / `SubgraphResult<G, NK, EK>` — fully generic option and result types

- [#35](https://github.com/nicia-ai/typegraph/pull/35) [`0ebc59c`](https://github.com/nicia-ai/typegraph/commit/0ebc59cf1f8d714b0d63c0759d08ed88face022c) Thanks [@pdlug](https://github.com/pdlug)! - Add runtime discriminated union types: `AnyNode<G>`, `AnyEdge<G>`, `SubsetNode<G, K>`, `SubsetEdge<G, K>`.

  These pure type-level utilities produce discriminated unions of runtime node/edge instances from a graph definition. Unlike `AllNodeTypes<G>` (union of type _definitions_), `AnyNode<G>` gives the union of runtime `Node<T>` values — discriminated by `kind` for exhaustive `switch` narrowing. `SubsetNode<G, K>` narrows the union to a specific set of kinds.

## 0.9.2

### Patch Changes

- [#27](https://github.com/nicia-ai/typegraph/pull/27) [`c2f0811`](https://github.com/nicia-ai/typegraph/commit/c2f0811863a61608c16901ce1fc61fdfbc26cb3f) Thanks [@pdlug](https://github.com/pdlug)! - Fix `count(alias, field)` and `countDistinct(alias, field)` ignoring the field argument in SQL compilation.

  Both functions always compiled to `COUNT(alias_id)` / `COUNT(DISTINCT alias_id)` regardless of the field argument, because:
  1. The aggregate emitters in `standard-builders.ts` and `set-operations.ts` hardcoded `_id` for count/countDistinct instead of calling `compileFieldValue()` like sum/avg/min/max do.
  2. `collectRequiredColumnsByAlias` in `standard-pass-pipeline.ts` explicitly skipped marking the field as required for count/countDistinct, so the CTE wouldn't include the `_props` column even if the emitter were fixed.

  Now `count("p", "email")` correctly compiles to `COUNT(json_extract(p_props, '$."email"'))` and `countDistinct("b", "genre")` compiles to `COUNT(DISTINCT json_extract(b_props, '$."genre"'))`.

## 0.9.1

### Patch Changes

- [#24](https://github.com/nicia-ai/typegraph/pull/24) [`733bf8a`](https://github.com/nicia-ai/typegraph/commit/733bf8abfd7b0fa9901a08ff67ce1c9343a2e961) Thanks [@pdlug](https://github.com/pdlug)! - Fix `checkUniqueBatch` exceeding SQL bind parameter limit on SQLite/D1/Durable Objects.

  Bulk constraint operations (`bulkGetOrCreateByConstraint`, `bulkFindByConstraint`) passed all keys in a single `IN (...)` clause. With hundreds of unique keys, this exceeded SQLite's 999 bind parameter limit, causing `SQLITE_ERROR: too many SQL variables`.

  The fix chunks the keys array in `checkUniqueBatch` using the same pattern already used by `getNodes`, `insertNodesBatch`, and other batch operations. SQLite chunks at 996 keys per query (999 max − 3 fixed params), PostgreSQL at 65,532.

## 0.9.0

### Minor Changes

- [#21](https://github.com/nicia-ai/typegraph/pull/21) [`88beee4`](https://github.com/nicia-ai/typegraph/commit/88beee42ce0ecfe2064b0b3889653e889b0c74aa) Thanks [@pdlug](https://github.com/pdlug)! - Add `transactionMode` to SQLite execution profile, fixing Cloudflare Durable Object compatibility.

  `createSqliteBackend` previously used raw `BEGIN`/`COMMIT`/`ROLLBACK` SQL for all sync SQLite drivers. This crashes on Cloudflare Durable Object SQLite (via `drizzle-orm/durable-sqlite`) because the driver does not support raw transaction SQL through `db.run()`.

  The new `transactionMode` option (`"sql"` | `"drizzle"` | `"none"`) controls how transactions are managed:
  - `"sql"` — TypeGraph issues `BEGIN`/`COMMIT`/`ROLLBACK` directly (default for better-sqlite3, bun:sqlite)
  - `"drizzle"` — delegates to Drizzle's `db.transaction()` (default for async drivers)
  - `"none"` — transactions disabled (default for D1 and Durable Objects)

  D1 and Durable Object sessions are auto-detected by Drizzle session name. Users can override via `executionProfile: { transactionMode: "..." }`.

  **Breaking:** `isD1` removed from `SqliteExecutionProfileHints` and `SqliteExecutionProfile`. Use `transactionMode: "none"` instead. `D1_CAPABILITIES` removed — capabilities are now derived from `transactionMode`.

## 0.8.0

### Minor Changes

- [#19](https://github.com/nicia-ai/typegraph/pull/19) [`5b1dec6`](https://github.com/nicia-ai/typegraph/commit/5b1dec64f280a2ec638c69b6fa5a1bc08ba92e88) Thanks [@pdlug](https://github.com/pdlug)! - Support unconstrained edges in `defineGraph`.

  Edges defined without `from`/`to` constraints (e.g., `defineEdge("sameAs")`) can now be passed directly to `defineGraph` without an `EdgeRegistration` wrapper. They are automatically allowed to connect any node type in the graph to any other.
  - **`EdgeEntry` widened** — accepts any `EdgeType`, not just those with endpoints
  - **`NormalizedEdges`** — falls back to all graph node types when `from`/`to` are undefined
  - Constrained edges, `EdgeRegistration` wrappers, and narrowing validation are unchanged

## 0.7.0

### Minor Changes

- [#16](https://github.com/nicia-ai/typegraph/pull/16) [`0a2f08f`](https://github.com/nicia-ai/typegraph/commit/0a2f08fa7d755ee6adb59db4d34a26a3863c0c79) Thanks [@pdlug](https://github.com/pdlug)! - Tighten type safety across store and collection APIs.

  **Breaking:** `TypedNodeRef<N>` has been renamed to `NodeRef<N>` and the old untyped `NodeRef` has been removed. Replace `TypedNodeRef<N>` with `NodeRef<N>` — the type is structurally identical. Unparameterized `NodeRef` (with the new default) covers the old untyped usage.
  - **`EdgeId<E>`** — branded edge ID type, mirroring `NodeId<N>`. Prevents mixing IDs from different edge types at compile time.
  - **`Edge<E, From, To>`** — edge instances now carry endpoint node types. `edge.fromId` is `NodeId<From>`, `edge.toId` is `NodeId<To>`, and `edge.id` is `EdgeId<E>`.
  - **`getNodeKinds` / `getEdgeKinds`** — return `readonly (keyof G["nodes"] & string)[]` instead of `readonly string[]`.
  - **`constraintName` literal unions** — `findByConstraint`, `getOrCreateByConstraint`, and their bulk variants now only accept constraint names that exist on the node registration, catching typos at compile time.

## 0.6.0

### Minor Changes

- [#14](https://github.com/nicia-ai/typegraph/pull/14) [`45624e0`](https://github.com/nicia-ai/typegraph/commit/45624e0ef5caf28c5a7bf8931f0ae96ce542c20d) Thanks [@pdlug](https://github.com/pdlug)! - Restructure SQLite/Postgres entry points to decouple DDL generation from native dependencies.

  **Breaking changes:**
  - `./drizzle`, `./drizzle/sqlite`, `./drizzle/postgres`, `./drizzle/schema/sqlite`, `./drizzle/schema/postgres` entry points are removed. Import backend factories, schema tables/factories, and DDL helpers from `./sqlite` and `./postgres`.
  - `createLocalSqliteBackend` moves from `./sqlite` to `./sqlite/local`. The `./sqlite` entry point no longer depends on `better-sqlite3`.
  - `getSqliteMigrationSQL` is renamed to `generateSqliteMigrationSQL`.
  - `getPostgresMigrationSQL` is renamed to `generatePostgresMigrationSQL`.
  - Individual table type aliases (`NodesTable`, `EdgesTable`, `UniquesTable`, `SchemaVersionsTable`, `EmbeddingsTable`) are removed from both schema modules. Use `SqliteTables["nodes"]` or `PostgresTables["edges"]` instead.

  **Migration guide:**

  | Before                                                                               | After                                                                              |
  | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
  | `import { ... } from "@nicia-ai/typegraph/drizzle/sqlite"`                           | `import { ... } from "@nicia-ai/typegraph/sqlite"`                                 |
  | `import { ... } from "@nicia-ai/typegraph/drizzle/postgres"`                         | `import { ... } from "@nicia-ai/typegraph/postgres"`                               |
  | `import { ... } from "@nicia-ai/typegraph/drizzle/schema/sqlite"`                    | `import { ... } from "@nicia-ai/typegraph/sqlite"`                                 |
  | `import { ... } from "@nicia-ai/typegraph/drizzle/schema/postgres"`                  | `import { ... } from "@nicia-ai/typegraph/postgres"`                               |
  | `import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite"`              | `import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite/local"`      |
  | `getSqliteMigrationSQL()`                                                            | `generateSqliteMigrationSQL()`                                                     |
  | `getPostgresMigrationSQL()`                                                          | `generatePostgresMigrationSQL()`                                                   |
  | `NodesTable`, `EdgesTable`, `UniquesTable`, `SchemaVersionsTable`, `EmbeddingsTable` | `SqliteTables["nodes"]` / `PostgresTables["nodes"]` (and corresponding table keys) |

## 0.5.0

### Minor Changes

- [#12](https://github.com/nicia-ai/typegraph/pull/12) [`c40b8a4`](https://github.com/nicia-ai/typegraph/commit/c40b8a4c99f5ccddaf1bceea8c927f6aeb0300f4) Thanks [@pdlug](https://github.com/pdlug)! - Add read-only lookup methods and store-level clear for graph data management.

  **New APIs:**
  - `findByConstraint` / `bulkFindByConstraint` — look up nodes by a named uniqueness constraint without creating. Returns `Node<N> | undefined` (or `(Node<N> | undefined)[]` for bulk). Soft-deleted nodes are excluded.
  - `findByEndpoints` — look up an edge by `(from, to)` with optional `matchOn` property fields without creating. Returns `Edge<E> | undefined`. Soft-deleted edges are excluded.
  - `store.clear()` — hard-delete all data for the current graph (nodes, edges, uniques, embeddings, schema versions). Resets collection caches so the store is immediately reusable.

## 0.4.0

### Minor Changes

- [#10](https://github.com/nicia-ai/typegraph/pull/10) [`550eec6`](https://github.com/nicia-ai/typegraph/commit/550eec6bbe34427be9095fe59571b55f75c68792) Thanks [@pdlug](https://github.com/pdlug)! - Add node and edge get-or-create operations with explicit API naming.

  **New APIs:**
  - `getOrCreateByConstraint` / `bulkGetOrCreateByConstraint` — deduplicate nodes by a named uniqueness constraint
  - `getOrCreateByEndpoints` / `bulkGetOrCreateByEndpoints` — deduplicate edges by `(from, to)` with optional `matchOn` property fields
  - `hardDelete` for node and edge collections
  - `action: "created" | "found" | "updated" | "resurrected"` result discriminant

  **Breaking changes:**
  - `upsert` → `upsertById`, `bulkUpsert` → `bulkUpsertById`
  - `onConflict: "skip" | "update"` → `ifExists: "return" | "update"`
  - `ConstraintNotFoundError` → `NodeConstraintNotFoundError`
  - Removed generic `FindOrCreate*` type exports in favor of explicit `NodeGetOrCreateByConstraint*` and `EdgeGetOrCreateByEndpoints*` types

## 0.3.1

### Patch Changes

- [#8](https://github.com/nicia-ai/typegraph/pull/8) [`4732792`](https://github.com/nicia-ai/typegraph/commit/4732792a9ff7ed665f55bb314029c06024f5b62e) Thanks [@pdlug](https://github.com/pdlug)! - Fix `AnyPgDatabase` type to accept standard Drizzle instances created without an explicit schema

## 0.3.0

### Minor Changes

- [#6](https://github.com/nicia-ai/typegraph/pull/6) [`4553aed`](https://github.com/nicia-ai/typegraph/commit/4553aedf3cd7390acb7509e1c321a42bed225f1e) Thanks [@pdlug](https://github.com/pdlug)! - Big performance increases, cleaner APIs, prepared queries, and batch collection
  APIs.

  ### Breaking Changes

  **Renamed APIs:**
  - `selectAggregate()` is now `aggregate()`
  - `EdgeTypeNames` / `NodeTypeNames` are now `EdgeKinds` / `NodeKinds` (including getter functions)

  **Traversal expansion:** `includeImplyingEdges` replaced with `expand` option supporting four modes: `"none"`, `"implying"`, `"inverse"`, and `"all"` (default: `"inverse"`)

  **Recursive traversal:** The chained methods `.maxHops()`, `.minHops()`, `.collectPath()`, and `.withDepth()` are consolidated into a single `recursive()` call with an options object:

  ```ts
  // Before
  .traverse("p", "knows", "friend").recursive().maxHops(5).collectPath()

  // After
  .traverse("p", "knows", "friend").recursive({ maxHops: 5, path: true })
  ```

  New `cyclePolicy: "prevent" | "allow"` option (default: `"prevent"`). Unbounded recursion capped at depth 100; explicit `maxHops` validated up to 1,000.

  **Store:** `Store` class is now a type-only export — use `createStore()`. `StoreConfig` replaced by `StoreOptions`.

  **Moved to `@nicia-ai/typegraph/schema`:** All schema management APIs (`serializeSchema`, `deserializeSchema`, `initializeSchema`, `ensureSchema`, `migrateSchema`, `computeSchemaDiff`, `getMigrationActions`, `isBackwardsCompatible`, and related types) are now imported from the new `@nicia-ai/typegraph/schema` entry point.

  **Removed from main entry:** `KindRegistry`, Result utilities (`ok`/`err`/`isOk`/`isErr`/`unwrap`/`unwrapOr`), date helpers (`encodeDate`/`decodeDate`), validation utilities, and compiler/profiler internals.

  ### New Features

  **Prepared queries** — precompile queries once and execute repeatedly with different bindings at zero recompilation cost:

  ```ts
  const prepared = store
    .query()
    .from("Person", "p")
    .whereNode("p", (p) => p.name.eq(param("name")))
    .select((ctx) => ctx.p)
    .prepare();

  const alice = await prepared.execute({ name: "Alice" });
  const bob = await prepared.execute({ name: "Bob" });
  ```

  **Batch collection APIs:**
  - `getByIds(ids)` — batched lookup preserving input order, returns `undefined` for missing IDs
  - `bulkInsert` — void-returning fire-and-forget ingestion
  - `bulkCreate` — multi-row `INSERT ... RETURNING` instead of per-item inserts
  - `bulkUpsert` (edges) — batch lookup instead of N+1 sequential calls

  **Node `find({ where })`** — filter nodes using the full query predicate system directly from collections.

  ### Performance
  - SQL compiler restructured into plan/passes/emitter pipeline with predicate pre-indexing, column pruning, and single-hop recursive lowering
  - Drizzle backend split into modular operations with dialect-driven strategy dispatch
  - SQLite prepared statement caching with LRU eviction
  - Compilation caching on immutable query builder instances
  - Bind-limit-aware batch chunking (SQLite: 999 params, PostgreSQL: 65,535 params)
  - Benchmark regression guardrails added to CI for both SQLite and PostgreSQL

## 0.2.0

### Minor Changes

- [`bdd5f34`](https://github.com/nicia-ai/typegraph/commit/bdd5f349453b19e9616f00d7591b436195feb925) Thanks [@pdlug](https://github.com/pdlug)! - Improve support for custom table names and use web crypto to support both node and edge runtimes.

## 0.1.1

### Patch Changes

- [`6f16bf9`](https://github.com/nicia-ai/typegraph/commit/6f16bf93ebd0811f386df63b80b8b80a3ee26c2f) Thanks [@pdlug](https://github.com/pdlug)! - Verify npmjs trusted publishing

## 0.1.0

### Minor Changes

- [`3d78324`](https://github.com/nicia-ai/typegraph/commit/3d78324472ac4cb4ac929b52c7501c08a5e7b6ca) Thanks [@pdlug](https://github.com/pdlug)! - Initial public release
