---
"@nicia-ai/typegraph": minor
---

Pre-0.25.0 cleanup and performance pass across graph-extension handling, schema lifecycle flows, store materialization, backend status tracking, and query compilation. This release is marked `minor` for additive TypeScript surface changes; existing runtime behavior is intended to stay compatible.

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
