import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Extractor,
  ExtractorConfig,
  ExtractorLogLevel,
  ExtractorMessageId,
} from "@microsoft/api-extractor";

type PackageExport = Readonly<{ types: string }>;
type PackageManifest = Readonly<{
  exports: Readonly<Record<string, PackageExport>>;
}>;

const PACKAGE_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const PACKAGE_JSON_PATH = path.join(PACKAGE_FOLDER, "package.json");
const EXTRACTOR_CONFIG_PATH = path.join(PACKAGE_FOLDER, "api-extractor.json");
const REPORT_FOLDER = path.join(PACKAGE_FOLDER, "etc");
const VERIFY_REPORT_FOLDER = path.join(
  PACKAGE_FOLDER,
  "node_modules/.cache/typegraph-api-report/verify",
);
const DIAGNOSTIC_APPENDIX_MARKER =
  "\n// Warnings were encountered during analysis:\n";

type ForgottenExportDebt = Readonly<{ count: number; sha256: string }>;

const EMPTY_FORGOTTEN_EXPORT_DEBT: ForgottenExportDebt = {
  count: 0,
  sha256: createHash("sha256").update("").digest("hex"),
};

/**
 * Exact fingerprints of pre-existing forgotten-export debt. The new backend
 * authoring entrypoint is intentionally absent: new entrypoints default to
 * zero debt. A changed symbol set fails verification even when its count is
 * unchanged, while API report diffs continue to show the declaration change.
 *
 * `recursiveTraversal` batch (WS5 B1): the six member-bearing entrypoints
 * that never named `RecursiveTraversalVerdict` / `RecursiveTraversalCapability`
 * directly (`./graph-merge`, `./interchange`, `./profiler`, `./provenance`,
 * `./sqlite/local`, `./postgres/pglite`) each gained exactly those two as
 * forgotten exports (+2 apiece) — the `RECURSIVE_TRAVERSAL_VERDICT` brand
 * itself does NOT register as a forgotten export, matching the
 * `RECORDED_INSTANT_BRAND` precedent in `etc/typegraph-backend.api.md`
 * (present there, pre-existing, contributing zero debt): a `unique symbol`
 * used only as a computed brand key never triggers API Extractor's
 * ae-forgotten-export diagnostic. `.` gained nothing (both types are
 * directly exported there). `./schema` and the five `./adapters/drizzle/*`
 * entrypoints each gained exactly `RecursiveTraversalCapability` (+1 — they
 * never see the verdict type). `./backend` is the one entry that moved for a
 * DIFFERENT reason than the capability types: `recursiveTraversalUnsupportedError`
 * declares `ConfigurationError` as its return type, which `./backend` does not
 * otherwise export, so `ConfigurationError` and its own shape
 * (`TypeGraphError`, `TypeGraphErrorOptions`, `ErrorCategory`) all became
 * newly forgotten there (+4) — a real, unpredicted category, reported as a
 * spec-vs-measurement conflict in the batch's implementation notes rather
 * than silently exported around, since doing so would be exactly the
 * "export machinery invented to avoid it" this ledger's discipline forbids.
 *
 * Capability bundle pilot batch (WS5 B6): `./backend` moved again, +4
 * (6 → 10). `src/backend/index.ts` re-exports the pilot registry, resolver
 * and accessor barrel (`src/backend/capabilities/index.ts`). Three of the
 * four are unexported HELPER type aliases in `capabilities/bind.ts`
 * (`UniqueSidecarBatchExtraMember`, `BatchPointReadExtraMember`,
 * `ContributionHealthExtraMember`) that name a graduated bundle's extra
 * members for its bundle-wide accessor's parameter/return types
 * (`uniqueSidecarBatchMembers`, `batchPointReadMembers`,
 * `contributionHealthMembers`) — deliberately private, since exporting them
 * would publish a per-bundle type with no cross-bundle meaning for a shape
 * every consumer already reaches through `ExtraMember<typeof BUNDLE, …>`.
 * The fourth, `CapabilityBundleCommon`, is `bundle-registry.ts`'s
 * intersection member shared by `GatedBundleDefinition` and
 * `GraduatedBundleDefinition` — named in the design's own sketch without an
 * `export` keyword, so its debt is the design's intent, not an oversight.
 * No other entrypoint moved: the barrel's other exports (`resolveBundle`,
 * `bindCore`, `bindExtra`, the six registry constants, the six verdict/
 * member accessors) are either concrete values or types every caller needs
 * named directly, so API Extractor never needed to invent a name for them.
 *
 * Pilot rewiring batch (WS5 B8): seven entrypoints moved, +20 apiece
 * (`.`, `./interchange`, `./profiler`, `./graph-merge`, `./provenance`,
 * `./sqlite/local`, `./postgres/pglite`) — every entrypoint whose public type
 * graph reaches `Store`/`HistoryStore`'s `[STORE_RUNTIME]` property. B8 adds
 * `StoreRuntime.uniqueSidecarBatch: BundleVerdictOf<typeof UNIQUE_SIDECAR_BATCH>`
 * (`store/runtime-port.ts`) so `provenance/index.ts`'s fact close/reopen path
 * can build a `NodeClaimContext` from the store's already-resolved verdict
 * instead of re-minting one — the same reason `StoreRuntime.backend` is
 * exposed there rather than reconstructed, and the T13(c) one-owner ratchet's
 * reason `provenance/index.ts` has no `uniqueSidecarBatchVerdict` minting
 * site of its own. The one new field's full type graph (`GraduatedBundleVerdict`,
 * `ExtraVerdicts`, `ExtraVerdict`, `SpecOf`, `CapabilityExtraSpec`, and the
 * `uniqueSidecarBatch` extra-member type helpers) becomes newly reachable —
 * and, being reachable through an `@internal`, non-enumerable symbol property
 * that was already present before B8 (`StoreRuntime.backend` etc.), this is
 * the established cost of that existing pattern, not a new one. `./backend`
 * is unaffected: `bindExtraIfReachable` and `missingRequiredExtras` are named
 * exports every caller reaches directly, so neither needed a forgotten name.
 *
 * Write-fence batch (WS5 B10, historical — `pessimisticLocks` and
 * `PessimisticLockCapabilities` were later deleted outright; see the removal
 * batch note after "Declared write-fence surface (#622)" below for the
 * current state): the same 14 entrypoints B1's
 * `recursiveTraversal` batch moved (every entrypoint rendering
 * `BackendCapabilities` unexported, plus `.` and `./backend`, which export it
 * directly) each move by exactly +1, but the ADDED SYMBOL is not the same
 * name everywhere — measured, not assumed:
 *
 * - 13 of the 14 (`.`, `./interchange`, `./profiler`, `./schema`,
 *   `./graph-merge`, `./provenance`, `./sqlite/local`, `./postgres/pglite`,
 *   and the five `./adapters/drizzle/*` entrypoints) gain
 *   `PessimisticLockCapabilities` (`src/backend/capabilities/write-fence.ts`)
 *   — the same shape `RecursiveTraversalCapability` took in B1, since
 *   `BackendCapabilities` is rendered unexported at all of them and none
 *   re-exports the write-fence functions that would make `WriteFenceTarget`
 *   reachable there too.
 * - `./backend` gains `WriteFenceTarget` instead, NOT
 *   `PessimisticLockCapabilities`: that type IS directly exported at
 *   `./backend` (this batch's barrel work), so it never needs a forgotten
 *   name there, but `resolveWriteFencePlan`'s parameter type
 *   (`WriteFenceTarget`, deliberately unexported per §6 of the batch spec —
 *   `resolveWriteFencePlan`'s own parameter type losing the design's
 *   `unique symbol` member is what keeps it structural) has no other name to
 *   go by.
 *
 * `WriteFencePlan` itself does NOT add to the debt anywhere: every one of its
 * 10 `resolveWriteFencePlan`/`requireWriteFence` call sites either reaches
 * `src/backend/index.ts`'s own barrel, which names the type directly
 * (mirroring `RecursiveTraversalVerdict`'s treatment at that same barrel), or
 * does not reach a rendered public signature at all. The first-party mark
 * (`markFirstPartyFactory`/`carryFirstPartyFactoryMark`), the two refusal
 * constructors, and `pessimisticLockDeclarationLine` (since deleted along
 * with the capability it printed, not merely left unexported) were
 * deliberately not exported anywhere, so none of them ever registered as a
 * forgotten export either. Delta table (old → new, all +1): `.` 352→353, `./backend` 10→11,
 * `./interchange` 604→605, `./profiler` 606→607, `./schema` 223→224,
 * `./graph-merge` 618→619, `./provenance` 612→613, `./sqlite/local` 608→609,
 * `./postgres/pglite` 608→609, `./adapters/drizzle/sqlite` 203→204,
 * `./adapters/drizzle/postgres` 202→203, `./adapters/drizzle/postgres/pglite`
 * 206→207, `./adapters/drizzle/sqlite/local` 206→207,
 * `./adapters/drizzle/sqlite/libsql` 206→207. Gate: every added symbol at
 * every entrypoint is `PessimisticLockCapabilities` OR (at `./backend` only)
 * `WriteFenceTarget`, nothing else, no entrypoint's debt DECREASED, and no
 * 15th entrypoint moved.
 *
 * Recorded-time DDL batch (#520): the 13 entrypoints that render
 * `GraphBackend` without directly exporting its newly referenced public types
 * each gain `RecordedRelationDdl` and `RecordedTableNames` (+2). `./backend`
 * exports both names directly, so its forgotten-export debt is unchanged.
 *
 * Durable graph templates (#532): the 14 entrypoints whose public type graph
 * reaches `GraphBackend` each gain `GraphTemplateRow` (+1). `./schema` gains
 * `ReconciledSchema` as well through the new template facade (+2 total).
 *
 * Fused schema-fence inserts (#533): the optional backend members add one
 * private parameter/result shape at `.` and `./backend`, and two at each of
 * the 12 entrypoints that render the full backend without those names (+1/+2
 * respectively). These are the measured API Extractor deltas from the
 * first-party fused insert contracts; no additional entrypoint moved.
 * #533 then widened the transaction schema-fence facet with the fused
 * schema-plus-graph lock member, adding one measured symbol to the 12
 * entrypoints which render that facet.
 *
 * Generated-node projection fusion (#533): replacing the two fulltext-only
 * members with the semantic `commands` port makes
 * `ManagedNodeCreateMode`, `ManagedNodeCreatePlan`, and `NodeInsertProjection` reachable
 * through the 12 entrypoints which render `GraphBackend` without exporting
 * those backend-authoring types directly (+3 each). `.` and `./backend`
 * export all three names, so their forgotten-export debt is unchanged.
 * Extending that plan with `NodeInsertClaim` adds that one name to the same
 * 12 rendering entrypoints (+1 each); `.` and `./backend` export it directly.
 * Making each claim's database verdict explicit adds
 * `NodeInsertClaimVerdict` to those same 12 entrypoints (+1 each); the root and
 * backend barrels export the name directly and therefore add no debt.
 *
 * Compiled edge creates: replacing the three specialized edge hooks with the
 * semantic `commands` port makes its command and result unions reachable
 * through the same backend-rendering entrypoints. The root and backend barrels
 * export those names directly. The final command contract keeps only session
 * and coordination evidence; removing the inert atomicity, authority, and
 * result-cache aliases reduces forgotten-export debt by three at each of the
 * 12 rendering entrypoints.
 * Carrying the effective transaction isolation in the command coordination
 * evidence adds `GraphCommandIsolation` to those same 12 rendering
 * entrypoints (+1 each). The root and backend barrels export it directly.
 *
 * Durable edge match identities: persisting the canonical identity pair on
 * `EdgeRow` and `InsertEdgeParams` makes `EdgeMatchIdentityStorage` reachable
 * through all 14 backend-rendering entrypoints (+1 each). The eight
 * store-facing entrypoints (`./interchange`, `./profiler`, `./schema`,
 * `./graph-merge`, `./provenance`, `./sqlite/local`, `./postgres/pglite`, and
 * the root store graph) also render the new durable branch of
 * `EdgeConvergenceMatch`; the root exports that name directly, while the
 * other seven gain it as forgotten-export debt (+1 each). The backend and
 * Drizzle adapter barrels already export `EdgeConvergenceMatch`, so their
 * only added forgotten name is `EdgeMatchIdentityStorage`.
 *
 * Durable edge batches and explicit schema row scopes: the root and backend
 * barrels export `DurableEdgeBatchMembers` directly. The other 12 entrypoints
 * that render `GraphBackend` gain that name plus the three schema-commit names
 * exposed by replacing the old inline probe/result shapes:
 * `SchemaKindEmptinessProbe`, `PopulatedSchemaKind`, and
 * `CommitSchemaVersionIfKindsEmptyResult` (+4 each).
 *
 * TypeGraph 0.54 clean-surface batch: schema annotations, store analysis,
 * runtime kind tokens, candidate-write planning, and the dedicated guarded
 * update port widen the type graph rendered by Store- and Backend-bearing
 * entrypoints. The entrypoint-specific counts and fingerprints below are the
 * measured API Extractor result after exporting the intended public contracts;
 * `./core` and the Drizzle indexes entrypoint are unchanged.
 *
 * `./adapters/drizzle/engine`: `SqlEngineProfile` and `EngineAssemblyContext`
 * name the internal backend vocabulary — command ports, row shapes,
 * capability records, the `Create*MembersDeps` shapes behind the six
 * `*Runtime` head types, `WriteFenceTarget`, `InternalOperationBackend` —
 * that this entrypoint deliberately does not republish, so nearly all of it
 * surfaces as forgotten-export debt rather than a direct export, in family
 * with the other adapter entrypoints.
 *
 * Fence-plan spelling: `GraphBackend` gaining an optional `fenceSql: FenceSql`
 * member makes `FenceSql` newly reachable through the same 14 entrypoints the
 * write-fence batch above already moved for `PessimisticLockCapabilities`
 * (a symbol later deleted outright — see the removal batch note after
 * "Declared write-fence surface (#622)" below; named here only to identify
 * which 14 entrypoints share this type graph)
 * (every entrypoint whose public type graph renders `GraphBackend` /
 * `BackendIdentity` without directly exporting it), each +1: `.`,
 * `./interchange`, `./profiler`, `./schema`, `./graph-merge`, `./provenance`,
 * `./sqlite/local`, `./postgres/pglite`, and the five `./adapters/drizzle/*`
 * entrypoints. `./backend` is unaffected: it exports `FenceSql` directly.
 *
 * Graph-template statement builder split: `CreateGraphTemplateMembersDeps`
 * drops its `dialect` field and gains `instantiateStatement`, a profile-owned
 * builder keyed on the params shape the two statement builders in
 * `graph-template-sql.ts` already took. That params type,
 * `InstantiateGraphTemplateSqlParams`, is newly reachable through
 * `./adapters/drizzle/engine`'s already-unexported `Create*MembersDeps`
 * family — the one entrypoint that renders this internal vocabulary at all
 * — for +1.
 *
 * Catalog probe bag: `GraphBackend` gaining an optional `catalog:
 * BackendCatalogProbes` member makes six names newly reachable —
 * `BackendCatalogProbes` itself, `CatalogBackend` (the facet `TransactionBackend`
 * composes it through), `CatalogColumn`, `CatalogIndexBehavior`, `IndexState`,
 * and `NormalizedColumnKind` — at every entrypoint whose public type graph
 * renders `GraphBackend`/`TransactionBackend` without directly exporting them:
 * `.`, `./interchange`, `./profiler`, `./schema`, `./graph-merge`,
 * `./provenance`, `./sqlite/local`, `./postgres/pglite`,
 * `./adapters/drizzle/engine`, and the four remaining `./adapters/drizzle/*`
 * entrypoints (+6 each). `./backend` directly exports all six names alongside
 * the rest of the backend-authoring vocabulary, so its debt is unchanged.
 *
 * The catalog bag's bulk table-existence member, `tablesExist`, adds a
 * seventh name — `TableState` — newly reachable at the same fourteen
 * entrypoints (+1 each, on top of the six above). `./backend` again exports
 * it directly, so its debt stays unchanged.
 *
 * Builder export batch: exporting `buildPostgresEngineProfile` and
 * `buildSqliteEngineProfile` from `./adapters/drizzle/engine` — previously
 * reachable only through `createPostgresBackend`/`createSqliteBackend` in
 * the released `./adapters/drizzle/postgres` / `./adapters/drizzle/sqlite`
 * entrypoints, which export each builder's own options and table types
 * directly — makes their full parameter and return type graph newly
 * reachable and unexported HERE: the two dialect-database aliases each
 * function's `db` parameter needs (`AnyPgDatabase`, `AnyPgTransaction`,
 * `AnySqliteDatabase`), each `options` parameter type
 * (`PostgresBackendOptions` / `SqliteBackendOptions`) and everything its
 * `tables` field reaches (`PostgresTables`/`SqliteTables`,
 * `CreatePostgresTablesOptions`/`CreateSqliteTablesOptions`,
 * `PostgresTableNames`/`SqliteTableNames`), plus
 * `BundledBackendCapabilityOverrides`, `SqliteTransactionMode`,
 * `SerializedResourceDeclaration`, `GraphIdentityConfig`, and the
 * contribution-diagnostic shapes each options type's `capabilities`/
 * `contributionRepair` fields reach. `PostgresTables`/`SqliteTables` are
 * inferred from the anonymous Drizzle table-builder return type of
 * `createPostgresTables`/`createSqliteTables` rather than a named export, so
 * API Extractor inlines the full column-builder shape for every column of
 * every bundled table — the bulk of this batch's line count. No other
 * entrypoint moved.
 *
 * `deriveEngineProfile` batch: exporting `deriveEngineProfile`,
 * `DerivableEngineProfileKey`, `DerivableEngineProfileOverrides`,
 * `DERIVABLE_ENGINE_PROFILE_KEYS`, and `BackendResourceAudit` from
 * `./adapters/drizzle/engine` reaches no vocabulary this entrypoint's type
 * graph did not already render as forgotten-export debt (`SqlEngineProfile`,
 * `FenceSql`, and `BackendResourceAudit` itself were already reachable
 * through the builders' own return types) — except `BackendResourceAudit`
 * moving from forgotten to directly exported, which reduces this
 * entrypoint's debt count by exactly the one name (−1). No other entrypoint
 * moved.
 *
 * Opaque assembly batch: replacing `SqlEngineProfile.buildOperations` /
 * `.lateMembers` with one opaque `assembly: EngineAssembly<TTx>` field
 * removes `EngineAssemblyContext`, `EngineOperationsContext`,
 * `EngineLateMembers`, and everything reachable only through them
 * (`InternalOperationBackend`, `ContributionMaterializer`, and one of the
 * two prior occurrences of `WriteFenceTarget`) from this entrypoint's type
 * graph. `WriteFenceTarget` itself does not disappear: `ContributionRuntime`
 * still reaches it through `CreateContributionMembersDeps.fenceTarget`, an
 * already-unexported field this batch does not touch. 347 → 320 (−27). No
 * other entrypoint moved.
 *
 * Canonical fence-statement spelling: `FenceSql` shrinks to its two
 * author-supplied expressions plus `lockTables`; the new `FenceStatements`
 * type (`FenceSql` intersected with the three derived standalone-statement
 * forms `resolveWriteFencePlan`'s `lock` arm now carries as `sql`, in place
 * of the bare `FenceSql` it carried before) is newly reachable only through
 * `WriteFencePlan`, which only `./backend` renders anywhere in its type
 * graph (+1: `FenceStatements`, 16 → 17). The 14 entrypoints the fence-plan
 * spelling batch above moved reach `FenceSql` through `GraphBackend
 * .fenceSql` instead, a field whose type is unchanged by this shrink, so
 * none of them render `WriteFencePlan`/`FenceStatements` and none move here.
 *
 * Declared write-fence surface (#622): `BackendCapabilities.writeFence?:
 * WriteFenceDeclaration` joins the capability bag as the mechanism/drain
 * declaration the deprecated `pessimisticLocks` maps onto.
 * `WriteFenceDeclaration` is exported directly from `./backend` (this
 * batch's barrel work), so that entrypoint's own debt is unchanged. Every
 * other entrypoint whose public type graph renders `BackendCapabilities`
 * without directly exporting `WriteFenceDeclaration` gains it as a forgotten
 * export (+1): the same 13 entrypoints the write-fence batch above moved for
 * `PessimisticLockCapabilities` (`.`, `./interchange`, `./profiler`,
 * `./schema`, `./graph-merge`, `./provenance`, `./sqlite/local`,
 * `./postgres/pglite`, and the five `./adapters/drizzle/*` sub-entrypoints
 * other than `./adapters/drizzle/engine`), plus `./adapters/drizzle/engine`
 * itself for the first time in this family — the builder-export batch above
 * made `SqlEngineProfile.declaredCapabilities: BackendCapabilities` reachable
 * there through the two builders it exported, so it now renders
 * `BackendCapabilities` unexported too. 14 entrypoints move, all +1, all for
 * the identical symbol; no entrypoint's debt decreases and no 15th
 * entrypoint moves.
 *
 * `pessimisticLocks` removal: `BackendCapabilities.pessimisticLocks`,
 * `PessimisticLockCapabilities`, `writeFenceFromLegacyLocks`, and
 * `pessimisticLockDeclarationLine` are deleted outright — `writeFence` is
 * now the only write-fence declaration. This is a debt DECREASE, the first
 * one this family has had: the 14 entrypoints that rendered
 * `PessimisticLockCapabilities` as a forgotten export (the 13 from the
 * write-fence batch above plus `./adapters/drizzle/engine`, which joined the
 * family in the `#622` batch just above) each lose exactly that one name
 * (−1): `.`, `./interchange`, `./profiler`, `./schema`, `./graph-merge`,
 * `./provenance`, `./sqlite/local`, `./postgres/pglite`, the five
 * `./adapters/drizzle/*` sub-entrypoints, and `./adapters/drizzle/engine`.
 * `./backend` loses a different name (−1): `UnfencedReason` — a forgotten
 * export there since the `WriteFencePlan`/`resolveWriteFencePlan` batch
 * above added the `unfenced` arm's `reason` field — is deleted along with
 * that field now that `undeclared` is the only way to reach `unfenced`.
 * `PessimisticLockCapabilities`, exported directly at `./backend`, also
 * disappears from that entrypoint's surface, but a direct export is not
 * forgotten-export debt, so it does not move this count. Delta table (old →
 * new, all −1): `.` 389→388, `./backend` 17→16, `./interchange` 702→701,
 * `./profiler` 704→703, `./schema` 272→271, `./graph-merge` 719→718,
 * `./provenance` 710→709, `./sqlite/local` 706→705, `./postgres/pglite`
 * 706→705, `./adapters/drizzle/sqlite` 248→247, `./adapters/drizzle/postgres`
 * 247→246, `./adapters/drizzle/postgres/pglite` 251→250,
 * `./adapters/drizzle/sqlite/local` 251→250,
 * `./adapters/drizzle/sqlite/libsql` 251→250, `./adapters/drizzle/engine`
 * 321→320. Gate: every entrypoint's debt DECREASED by exactly 1, the removed
 * symbol is `PessimisticLockCapabilities` everywhere except `./backend`
 * (`UnfencedReason`), and exactly 15 entrypoints moved.
 */
// Dynamic pinned edge lookup adds DynamicStoreViewEdgeCollection to the six
// non-root Store-bearing entrypoints. Removing that single name reproduces each
// previous fingerprint; the root exports the type directly and is unchanged.
// Generic traversal inference adds only ArrayNodeKinds and EdgeTargetKinds to
// the seven Store-bearing entrypoints. Removing those names reproduces each
// preceding fingerprint; these helpers are not new package entrypoint exports.
// `store.transaction`/`transactionWithReceipt` replacing their `options`
// parameter's type with the new `StoreTransactionOptions` adds exactly that
// one name (+1 apiece) to the six Store-bearing entrypoints that were not
// already at the root (`./graph-merge`, `./interchange`, `./postgres/pglite`,
// `./profiler`, `./provenance`, `./sqlite/local`); `.` exports the type
// directly, so its own debt is unchanged.
// `CreateGraphTemplateMembersDeps` gaining `fencePlan: WriteFencePlan` (the
// PostgreSQL binding's `instantiateStatement` reads it to decide whether the
// fused CTE's advisory lock is still sound) makes `WriteFencePlan` and its
// `sql: FenceStatements` member newly reachable at `./adapters/drizzle/engine`,
// the only entrypoint that names `CreateGraphTemplateMembersDeps` at all —
// exported directly there instead of booked as debt, so a profile author
// implementing `instantiateStatement` can name the dep's own type; no count
// changes anywhere.
//
// `Store.workingCopyOptions` batch: the new getter's return type,
// `WorkingCopyOptions` (`Omit<LiveStoreOptions, "history" | "revisionTracking">`),
// is exported directly at the root (`.`, unaffected) but is new debt
// everywhere else `Store`'s full member surface renders. Measured, not
// assumed — the added symbol set is not the same everywhere:
// - `./sqlite/local` and `./postgres/pglite` (705→706 apiece) gain only
//   `WorkingCopyOptions` itself: both already directly export `StoreHooks`
//   and its constituent hook-context types through their own backend
//   options, so nothing else it reaches needs a forgotten name.
// - `./graph-merge`, `./interchange`, `./profiler`, and `./provenance`
//   (718→726, 701→709, 703→711, 709→717 respectively, +8 apiece) gain
//   `WorkingCopyOptions` plus everything the `Omit` renders inline once
//   `LiveStoreOptions` is not itself directly exported there:
//   `LiveStoreOptions`, `BaseStoreOptions`, `StoreHooks`, `HookContext`,
//   `OperationHookContext`, `QueryHookContext`, and
//   `BulkOperationHookContext`. Gate: every added symbol at every moved
//   entrypoint is one of those eight names, no entrypoint's debt decreased,
//   and no other entrypoint moved.
//
// Ontology change classification batch (roadmap §3.A, item A): the fourth
// constraint-fence-audit family (`edgeEndpointAssignability`) adds
// `EdgeEndpointAllowance` and `MisassignedEdgeEndpointRow` to
// `src/backend/types.ts`'s `ReadConstraintFenceViolationsParams` /
// `ConstraintFenceViolationRows`, and the new `MigrationErrorDetails`
// `"ontology-tightening-violated"` member carries `changes: readonly
// OntologyChange[]` (whose own `probes?: readonly OntologyDataProbe[]` names
// the new `OntologyDataProbe` union and its `UniquenessComponentProbeGroup`
// member). `OntologyChange` itself was ALREADY forgotten-export debt
// everywhere it renders (pre-existing, via `SchemaDiff.ontology`) and so is
// NOT part of this batch's delta — only the four truly new names are.
// Measured, not assumed:
// - `./schema` (271→273, +2) and the six `./adapters/drizzle/*` sub-entrypoints
//   plus `./adapters/drizzle/engine` (each +2: `./adapters/drizzle/sqlite`
//   247→249, `./adapters/drizzle/postgres` 246→248,
//   `./adapters/drizzle/postgres/pglite` 250→252,
//   `./adapters/drizzle/sqlite/local` 250→252,
//   `./adapters/drizzle/sqlite/libsql` 250→252, `./adapters/drizzle/engine`
//   320→322) gain only `EdgeEndpointAllowance` and `MisassignedEdgeEndpointRow`:
//   `./schema` exports `OntologyChange` / `OntologyDataProbe` /
//   `UniquenessComponentProbeGroup` directly (`classifyOntologyChanges`,
//   `ontologyTighteningProbes`), so nothing else the new
//   `MigrationErrorDetails` member or the fourth audit family reaches needs a
//   forgotten name there or at the backend-adapter entrypoints, which never
//   name `OntologyChange` at all.
// - The seven `Store`-bearing entrypoints that do not export
//   `classifyOntologyChanges` (`.` 388→392, `./interchange` 709→713,
//   `./profiler` 711→715, `./graph-merge` 726→730, `./provenance` 717→721,
//   `./sqlite/local` 706→710, `./postgres/pglite` 706→710) each gain all four:
//   `EdgeEndpointAllowance`, `MisassignedEdgeEndpointRow`, `OntologyDataProbe`,
//   and `UniquenessComponentProbeGroup` (+4 apiece). `./backend`,
//   `./adapters/drizzle/indexes`, `./core`, `./graph-extension`, and
//   `./indexes` are unaffected: `./backend` exports `EdgeEndpointAllowance`
//   and `MisassignedEdgeEndpointRow` directly, and the other four never reach
//   `MigrationErrorDetails`, `ReadConstraintFenceViolationsParams`, or
//   `ConstraintFenceViolationRows` at all. Gate: every added symbol at every
//   moved entrypoint is one of the four names above (never `OntologyChange`
//   itself), no entrypoint's debt decreased, and exactly 14 entrypoints moved.
const FORGOTTEN_EXPORT_DEBT: Readonly<Record<string, ForgottenExportDebt>> = {
  ".": {
    count: 392,
    sha256: "90590b1f13bbc79accec374b63a51b617b4445789d1d0abf776c3085eb3cfd75",
  },
  "./adapters/drizzle/engine": {
    count: 322,
    sha256: "c1184d0391487c646381096ba4499a6b065f6249a24caaa0d47d237f40384b78",
  },
  "./adapters/drizzle/indexes": {
    count: 24,
    sha256: "6c11a8d2c13c886a2d6473f8af99d9c4988c7bbfe97545a6a6f748cdd18bf6d8",
  },
  "./adapters/drizzle/postgres": {
    count: 248,
    sha256: "14101f3a480081f3650fb72d0c65c73898e9ce6b1e622f25ffc3509af1029673",
  },
  "./adapters/drizzle/postgres/pglite": {
    count: 252,
    sha256: "7fc79f06823339308e4077229a53c97cad6c32ddc265a2658bcf982ad00983c0",
  },
  "./adapters/drizzle/sqlite": {
    count: 249,
    sha256: "8eef6c35cd1162acda9ed9f8f2c509aecda288112b719efc053b0c35782e79ab",
  },
  "./adapters/drizzle/sqlite/libsql": {
    count: 252,
    sha256: "28ddcda4fb17ca95efd42b00715b177ad4681aa473ea4cab6c8a2643cb449f6f",
  },
  "./adapters/drizzle/sqlite/local": {
    count: 252,
    sha256: "28ddcda4fb17ca95efd42b00715b177ad4681aa473ea4cab6c8a2643cb449f6f",
  },
  "./backend": {
    count: 16,
    sha256: "fbcbd40667f4a4374dd0e267e595a852e5dfeec68d3d4e5e775848bc6468738f",
  },
  "./core": {
    count: 72,
    sha256: "bf73c4f71677d2b3ec2e36bfd37e9ede5c3f57377fc923f0df2eb1b500cfc84d",
  },
  "./graph-extension": {
    count: 16,
    sha256: "1678650d02e0d9d7cc767ffbacbf163724c82fd4590c219b97d3dff85a6bf2f6",
  },
  // MergePlanReadContext derives its read-only surface from the runtime method
  // lists: EDGE_TEMPORAL_READ_NAMES, IDENTITY_READ_NAMES, and NODE_READ_NAMES.
  // These three implementation constants are referenced, not public exports.
  "./graph-merge": {
    count: 730,
    sha256: "ac9e2060f9ea27fb9e86d34aa149399103ca0f4ecb0331278c9f08400405f4ae",
  },
  "./indexes": {
    count: 46,
    sha256: "5a43d419097711d242c6208632e7e498374a5977eb10a7faba904b10e13f35cd",
  },
  "./interchange": {
    count: 713,
    sha256: "a2554712de880f0a40d4f97619da39c6c322574d095f01b1b5267a566ae37ac8",
  },
  "./postgres/pglite": {
    count: 710,
    sha256: "6f5552bf9a5e998997e3f965460d3e643f052c85fc71510adf94615ab81914f5",
  },
  "./profiler": {
    count: 715,
    sha256: "98ae19d1f08289dea5954115d2d694f3fb5b4be85993040910f28c3e74891c0d",
  },
  "./provenance": {
    count: 721,
    sha256: "3b7b8e200acec162f0d0d83f82bfa8ef7379e2bf9458d46c4a8ab3a64c230e47",
  },
  "./schema": {
    count: 273,
    sha256: "d8daaf0d30dddffcfd484018daba5fc0e4ebd0f96ac7cc4df65ff37f97a1b7e2",
  },
  "./sqlite/local": {
    count: 710,
    sha256: "6f5552bf9a5e998997e3f965460d3e643f052c85fc71510adf94615ab81914f5",
  },
};

function forgottenExportFingerprint(
  symbols: ReadonlySet<string>,
): ForgottenExportDebt {
  const sorted = [...symbols].toSorted();
  return {
    count: sorted.length,
    sha256: createHash("sha256").update(sorted.join("\n")).digest("hex"),
  };
}

function readForgottenExportSymbol(message: string): string {
  const match = /The symbol "([^"]+)" needs to be exported/.exec(message);
  if (match?.[1] === undefined) {
    throw new Error(`Unexpected ae-forgotten-export message: ${message}`);
  }
  return match[1];
}

function reportNameForExport(exportPath: string): string {
  if (exportPath === ".") return "typegraph";
  const suffix = exportPath
    .replace(/^\.\//, "")
    .replaceAll(/[^a-zA-Z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return `typegraph-${suffix}`;
}

function resolveTypesPath(typesPath: string): string {
  return path.resolve(PACKAGE_FOLDER, typesPath);
}

async function loadPackageManifest(): Promise<PackageManifest> {
  const source = await readFile(PACKAGE_JSON_PATH, "utf8");
  return JSON.parse(source) as PackageManifest;
}

async function removeStaleReports(
  folder: string,
  expectedReportFiles: ReadonlySet<string>,
): Promise<readonly string[]> {
  const files = await readdir(folder);
  const stale = files.filter(
    (file) => file.endsWith(".api.md") && !expectedReportFiles.has(file),
  );
  await Promise.all(stale.map((file) => unlink(path.join(folder, file))));
  return stale;
}

function stableApiReport(source: string): string {
  const normalized = source.replaceAll("\r\n", "\n");
  const appendixIndex = normalized.indexOf(DIAGNOSTIC_APPENDIX_MARKER);
  const report =
    appendixIndex === -1 ? normalized : normalized.slice(0, appendixIndex);
  return `${report.trimEnd()}\n`;
}

async function normalizeCheckedInReport(reportFileName: string): Promise<void> {
  const reportPath = path.join(REPORT_FOLDER, reportFileName);
  const source = await readFile(reportPath, "utf8");
  await writeFile(reportPath, stableApiReport(source));
}

async function verifyReport(reportFileName: string): Promise<boolean> {
  const [expected, actual] = await Promise.all([
    readFile(path.join(REPORT_FOLDER, reportFileName), "utf8"),
    readFile(path.join(VERIFY_REPORT_FOLDER, reportFileName), "utf8"),
  ]);
  const stableExpected = stableApiReport(expected);
  const stableActual = stableApiReport(actual);
  if (stableExpected === stableActual) return true;
  await printReportDifference(reportFileName, stableExpected, stableActual);
  return false;
}

const REPORT_DIFF_LINE_CAP = 400;

/**
 * Prints the normalized unified diff between the checked-in report and the
 * freshly generated one, so a CI failure names the contract change instead
 * of only the file. Capped, since a report is thousands of lines.
 */
async function printReportDifference(
  reportFileName: string,
  expected: string,
  actual: string,
): Promise<void> {
  const expectedPath = path.join(
    VERIFY_REPORT_FOLDER,
    `${reportFileName}.checked-in.normalized`,
  );
  const actualPath = path.join(
    VERIFY_REPORT_FOLDER,
    `${reportFileName}.generated.normalized`,
  );
  await Promise.all([
    writeFile(expectedPath, expected),
    writeFile(actualPath, actual),
  ]);
  const diff = spawnSync(
    "git",
    [
      "diff",
      "--no-index",
      "--no-color",
      "--unified=3",
      expectedPath,
      actualPath,
    ],
    { encoding: "utf8" },
  );
  const lines = diff.stdout.split("\n");
  const shown = lines.slice(0, REPORT_DIFF_LINE_CAP).join("\n");
  const omitted = Math.max(0, lines.length - REPORT_DIFF_LINE_CAP);
  console.error(shown);
  if (omitted > 0) console.error(`... ${omitted} more diff lines omitted.`);
}

async function run(): Promise<void> {
  const localBuild = process.argv.includes("--local");
  const manifest = await loadPackageManifest();
  const baseConfig = ExtractorConfig.loadFile(EXTRACTOR_CONFIG_PATH);
  const reports = Object.entries(manifest.exports).map(
    ([exportPath, exported]) => {
      const reportName = reportNameForExport(exportPath);
      return {
        exportPath,
        mainEntryPointFilePath: resolveTypesPath(exported.types),
        reportFileName: `${reportName}.api.md`,
      } as const;
    },
  );
  const expectedReportFiles: ReadonlySet<string> = new Set<string>(
    reports.map((report) => report.reportFileName),
  );

  if (localBuild) {
    const removed = await removeStaleReports(
      REPORT_FOLDER,
      expectedReportFiles,
    );
    for (const file of removed) console.log(`Removed stale API report ${file}`);
  } else {
    await mkdir(VERIFY_REPORT_FOLDER, { recursive: true });
    await removeStaleReports(VERIFY_REPORT_FOLDER, expectedReportFiles);
  }

  let failed = false;
  for (const report of reports) {
    console.log(`API report: ${report.exportPath}`);
    const apiReport = baseConfig.apiReport;
    if (apiReport === undefined) {
      throw new Error("api-extractor.json must define apiReport settings.");
    }
    const extractorMessageReporting =
      baseConfig.messages?.extractorMessageReporting ?? {};
    const config = ExtractorConfig.prepare({
      configObject: {
        ...baseConfig,
        mainEntryPointFilePath: report.mainEntryPointFilePath,
        apiReport: {
          ...baseConfig.apiReport,
          enabled: apiReport.enabled,
          reportFileName: report.reportFileName,
          reportFolder: localBuild ? REPORT_FOLDER : VERIFY_REPORT_FOLDER,
        },
        messages: {
          ...baseConfig.messages,
          extractorMessageReporting: {
            ...extractorMessageReporting,
            [ExtractorMessageId.ForgottenExport]: {
              addToApiReportFile: false,
              logLevel: ExtractorLogLevel.Warning,
            },
          },
        },
      },
      configObjectFullPath: EXTRACTOR_CONFIG_PATH,
      packageJsonFullPath: PACKAGE_JSON_PATH,
    });
    const forgottenExports = new Set<string>();
    const result = Extractor.invoke(config, {
      localBuild: true,
      printApiReportDiff: false,
      showVerboseMessages: false,
      messageCallback(message) {
        if (message.messageId !== "ae-forgotten-export") return;
        forgottenExports.add(readForgottenExportSymbol(message.text));
        message.handled = true;
      },
    });
    failed ||= !result.succeeded;
    const actualDebt = forgottenExportFingerprint(forgottenExports);
    const expectedDebt =
      FORGOTTEN_EXPORT_DEBT[report.exportPath] ?? EMPTY_FORGOTTEN_EXPORT_DEBT;
    if (
      actualDebt.count !== expectedDebt.count ||
      actualDebt.sha256 !== expectedDebt.sha256
    ) {
      failed = true;
      console.error(
        `Forgotten-export debt changed for ${report.exportPath}: ${JSON.stringify(actualDebt)}.`,
      );
      console.error(`Symbols: ${[...forgottenExports].toSorted().join(", ")}`);
    }
    if (localBuild) {
      await normalizeCheckedInReport(report.reportFileName);
    } else if (!(await verifyReport(report.reportFileName))) {
      failed = true;
      console.error(
        `API report changed: ${report.reportFileName}. Run pnpm api-report:update and review the contract diff.`,
      );
    }
  }

  if (!localBuild) {
    const files = await readdir(REPORT_FOLDER);
    const stale = files.filter(
      (file) => file.endsWith(".api.md") && !expectedReportFiles.has(file),
    );
    if (stale.length > 0) {
      failed = true;
      console.error(
        `Stale API reports are checked in: ${stale.join(", ")}. Run pnpm api-report:update.`,
      );
    }
  }

  if (failed) process.exitCode = 1;
}

await run();
