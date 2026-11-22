---
"@nicia-ai/typegraph": patch
---

A module that imports a single TypeGraph entrypoint can now export the inferred type of what that entrypoint returns under `declaration: true`.

**The error.** On 0.76.0, a file that imported only the package root and did `export const graph = defineGraph({...})` failed declaration emit with `TS2883: The inferred type of 'graph' cannot be named without a reference to 'IndexDeclaration' from './node_modules/@nicia-ai/typegraph/dist/store-entry.d-<hash>'` (TS2742 on TypeScript 5.9). Libraries and `composite` projects that export graphs, stores, queries, fragments or merge plans hit it, and the same class of error reached every covered subpath: a type an entrypoint's declarations named was often exported only by a different entrypoint, and TypeScript can only name a type through a module already in the consumer's program.

**The fix.** Each entrypoint's declarations now load the public subpaths that export the types they name, through `/// <reference path>` directives at the top of each entry `.d.ts`, which the declaration build writes while it generates the bundle. TypeScript then writes those types as `import("@nicia-ai/typegraph/query").…` and so on, never as a `dist/` chunk path. The root loads the subpaths that export what any entrypoint needs; every other entrypoint loads the root (an adapter's runtime-specific variant loads its adapter). This works under `moduleResolution` `bundler` and `node16`, with `skipLibCheck` on or off, and for a library whose tsup/rollup-plugin-dts build rolls its declarations with TypeGraph kept external. The workaround of adding `import type {} from "@nicia-ai/typegraph/indexes";` (or a type annotation) to the module that exports the graph is no longer needed. The root's export list is unchanged, and no runtime export changed anywhere.

**Newly importable types.** 384 types that public signatures named but no entrypoint exported are now type-only exports of the subpath that owns them: mostly query-builder, expression and fragment helper types on `@nicia-ai/typegraph/query`, store option and collection helper types on `/store`, and graph-definition helpers on `/core`, with a few on `/indexes`, `/graph-merge`, `/provenance`, `/schema`, `/graph-extension`, `/profiler`, `/identity`, `/adapters/drizzle/sqlite` and `/adapters/drizzle/indexes`. They exist so declaration emit can name them; most are not meant to be written by hand.

**Not exportable by inference.** A public signature whose type names a backend-authoring contract, which only `@nicia-ai/typegraph/backend` exports and semver does not cover, still fails declaration emit when you export a value inferred from it: the backend an adapter factory returns, `store.capabilities`, the result of `query.compile()`, a fulltext or vector strategy, and the rest of the list below. Export the value it belongs to instead (the store rather than its backend or capabilities, the query rather than its compiled SQL), give the export an explicit type of your own, or annotate a backend as `GraphBackend`. The complete list, by declaration and member:

<!-- authoring-type-signatures:start -->
- `AdapterStoreReconciliation`: `withBackend` (names `AdapterBackend`)
- `BatchableQuery`: `executeOn` (names `TransactionBackend`)
- `BundledBackendCapabilityOverrides`: itself (names `BackendCapabilities`)
- `CompileQueryOptions`: `fulltextStrategy`, `recursiveTraversal`, `vectorStrategy` (names `FulltextStrategy`, `RecursiveTraversalVerdict`, `VectorStrategy`)
- `createAdapterStore`: itself (names `AdapterBackend`)
- `createAdapterStoreWithSchema`: itself (names `AdapterBackend`)
- `createPgvectorStrategy`: itself (names `VectorStrategy`)
- `createPostgresBackend`: itself (names `AdapterBackend`)
- `createPostgresTransactionBackend`: itself (names `AdapterBackend`)
- `createSqliteBackend`: itself (names `AdapterBackend`)
- `createVerifiedAdapterStore`: itself (names `AdapterBackend`)
- `EdgeMeta`: itself (names `EdgeRow`)
- `ExecutableAggregateQuery`: `compile`, `executeOn` (names `CompiledSelectSql`, `TransactionBackend`)
- `ExecutableProjectionQuery`: `compile`, `compileOneStatementBatchItem`, `executeOn` (names `CompiledRowsSql`, `TransactionBackend`)
- `ExecutableQuery`: `compile`, `compileNodeCandidateIds`, `executeOn` (names `CompiledSelectSql`, `TransactionBackend`)
- `ExecutableRelationQuery`: `compile`, `compileOneStatementBatchItem`, `executeOn` (names `CompiledRowsSql`, `TransactionBackend`)
- `fts5Strategy`: itself (names `FulltextStrategy`)
- `generatePostgresDDL`: itself (names `FulltextStrategy`)
- `generatePostgresDropSQL`: itself (names `FulltextStrategy`)
- `generatePostgresMigrationSQL`: itself (names `FulltextStrategy`)
- `generateSqliteDDL`: itself (names `FulltextStrategy`)
- `generateSqliteMigrationSQL`: itself (names `FulltextStrategy`)
- `GraphBackend`: every member (the backend contract; its vocabulary is exported only by `@nicia-ai/typegraph/backend`)
- `LibsqlBackendOptions`: `schemaProvisioning` (names `SchemaProvisioning`)
- `LibsqlBackendResult`: `backend` (names `AdapterBackend`)
- `libsqlVectorStrategy`: itself (names `VectorStrategy`)
- `LocalPgliteBackendOptions`: `fulltext`, `schemaProvisioning` (names `FulltextStrategy`, `SchemaProvisioning`)
- `LocalPgliteBackendResult`: `backend` (names `AdapterBackend`)
- `LocalPgliteStoreOptions`: `fulltext` (names `FulltextStrategy`)
- `LocalSqliteBackendOptions`: `fulltext`, `schemaProvisioning` (names `FulltextStrategy`, `SchemaProvisioning`)
- `LocalSqliteBackendResult`: `backend` (names `AdapterBackend`)
- `LocalSqliteStoreOptions`: `fulltext` (names `FulltextStrategy`)
- `NodeCandidateQuery`: `compileNodeCandidateIds` (names `CompiledSelectSql`)
- `NodeMeta`: itself, `version` (names `NodeRow`)
- `OneStatementBatchableQuery`: `compileOneStatementBatchItem` (names `CompiledSelectSql`)
- `pgvectorStrategy`: itself (names `VectorStrategy`)
- `PostgresBackendOptions`: `fulltext`, `schemaProvisioning`, `vector` (names `FulltextStrategy`, `SchemaProvisioning`, `VectorStrategy`)
- `postgresFenceSql`: itself (names `FenceSql`)
- `PostgresWorkingCopyOptions`: `connect` (names `VectorStrategy`)
- `RecordedReadSource`: `predicate`, `source` (names `RecordedSourceTable`, `SqlFragment`)
- `resolveGraphVectorSlots`: itself (names `VectorSlot`)
- `SqliteBackendOptions`: `fulltext`, `schemaProvisioning`, `vector` (names `FulltextStrategy`, `SchemaProvisioning`, `VectorStrategy`)
- `sqliteVecStrategy`: itself (names `VectorStrategy`)
- `SqlSchema`: `edgesTable`, `fulltextTable`, `identityAssertionsTable`, `identityClosureTable`, `identitySeparationTable`, `identityTransitionRetentionTable`, `identityTransitionsTable`, `nodesTable`, `recordedClockTable`, `recordedEdgesTable`, `recordedIdentityAssertionsTable`, `recordedNodesTable`, `revisionOriginsTable`, `tables` (names `ResolvedSqlTableNames`, `SqlFragment`)
- `SqlSchemaFields`: `edgesTable`, `fulltextTable`, `identityAssertionsTable`, `identityClosureTable`, `identitySeparationTable`, `identityTransitionRetentionTable`, `identityTransitionsTable`, `nodesTable`, `recordedClockTable`, `recordedEdgesTable`, `recordedIdentityAssertionsTable`, `recordedNodesTable`, `revisionOriginsTable`, `tables` (names `ResolvedSqlTableNames`, `SqlFragment`)
- `StoreCore`: `capabilities` (names `BackendCapabilities`)
- `StoreSearchContext`: `batchPointRead` (names `BATCH_POINT_READ`, `BundleVerdictOf`)
- `TransactionCollections`: `backend` (names `TransactionReadBackend`)
- `tsvectorStrategy`: itself (names `FulltextStrategy`)
- `UnionableQuery`: `compile`, `executeOn` (names `CompiledSelectSql`, `TransactionBackend`)
<!-- authoring-type-signatures:end -->

**Build.** `pnpm build` now runs the declaration rollup itself instead of through tsup, so `pnpm build --out-dir <dir>` and `pnpm build --format esm` (or `cjs`) write declarations, with their loads, to the directory and formats the JavaScript build uses, and a `pnpm dev` watch session writes every entry declaration complete on each rebuild.
