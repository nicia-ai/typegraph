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
// - The six `Store`-bearing entrypoints that do not export
//   `classifyOntologyChanges` (`./interchange` 709→713, `./profiler`
//   711→715, `./graph-merge` 726→730, `./provenance` 717→721, `./sqlite/local`
//   706→710, `./postgres/pglite` 706→710) each gain all four:
//   `EdgeEndpointAllowance`, `MisassignedEdgeEndpointRow`, `OntologyDataProbe`,
//   and `UniquenessComponentProbeGroup` (+4 apiece). `./backend`,
//   `./adapters/drizzle/indexes`, `./core`, `./graph-extension`, and
//   `./indexes` are unaffected: `./backend` exports `EdgeEndpointAllowance`
//   and `MisassignedEdgeEndpointRow` directly, and the other four never reach
//   `MigrationErrorDetails`, `ReadConstraintFenceViolationsParams`, or
//   `ConstraintFenceViolationRows` at all.
// - `.` (the package root) is the one Store-bearing entrypoint that does NOT
//   gain any of the four: `src/index.ts` exports `EdgeEndpointAllowance` and
//   `MisassignedEdgeEndpointRow` directly (alongside `ConstraintFenceViolation`)
//   and `OntologyDataProbe` / `UniquenessComponentProbeGroup` directly
//   (alongside the schema-reads block), so a consumer of
//   `"@nicia-ai/typegraph"` alone can name every field of a narrowed
//   `ConstraintFenceViolation` or `MigrationErrorDetails` without a subpath
//   import. IN THIS BATCH's OWN commit, its debt therefore stayed at the
//   pre-batch baseline (388), not 388→392 — item D.2 below moves `.` on top
//   of that baseline instead. Gate (item A's own commit): every added symbol
//   at every OTHER moved entrypoint is one of the four names above (never
//   `OntologyChange` itself, which is pre-existing debt everywhere including
//   `.`), `.` is the one entrypoint this batch leaves unchanged, no OTHER
//   entrypoint's debt decreased, and exactly 13 entrypoints moved in this
//   commit (a later batch, item D.2, moves more — see below).
//
// Edge acyclicity batch (roadmap §3.D.2, item D.2): the store's
// `assertEdgeRelationsAcyclic` / `readEdgeAcyclicityViolations` add a fifth
// `ConstraintFenceViolation` member (`src/store/claims/verify.ts`),
// `EdgeAcyclicityViolation` (`src/store/acyclicity.ts`) — internal, exported
// by name at NO entrypoint, unlike item A's `EdgeEndpointAllowance` /
// `MisassignedEdgeEndpointRow`. A consumer narrowing `ConstraintFenceViolation`
// to `{ family: "edgeAcyclicity" }` can therefore never import its shape by
// name from any subpath, including `.` itself. Measured, not assumed: every
// one of item A's SEVEN `ConstraintFenceViolation`-reaching entrypoints gains
// exactly this one name, +1 apiece, on top of item A's own baseline —
// `.` (388→389), `./graph-merge` (730→731), `./interchange` (713→714),
// `./postgres/pglite` (710→711), `./profiler` (715→716), `./provenance`
// (721→722), and `./sqlite/local` (710→711). No other entrypoint moves:
// `./schema`, the six `./adapters/drizzle/*` sub-entrypoints, `./backend`,
// `./core`, `./graph-extension`, `./adapters/drizzle/indexes`, and
// `./indexes` never reach `ConstraintFenceViolation` at all. Gate: every
// moved entrypoint gains exactly one name (`EdgeAcyclicityViolation`), `.`
// is no longer exempt the way it was in item A (a batch CAN move it — the
// exemption was about item A's four names specifically, not a standing
// invariant), no entrypoint's debt decreased, and exactly 7 entrypoints
// moved in THIS commit.
//
// Target-side edge cardinality (issue #610): every entrypoint that reaches
// `GraphBackend`, `ManagedEdgeCreatePlan`, `CardinalityErrorDetails`,
// `MigrationErrorDetails`, or the serialized/introspected edge shapes picks
// up `EdgeCardinalityAxisRef`, `EdgeCardinalityDirection`,
// `ConstrainedCardinality`, `ConstrainedTargetCardinality`, and/or
// `CountEdgesAtEndpointParams` as forgotten exports (the renamed
// `countEdgesFrom` → `countEdgesAtEndpoint` member and its widened claim/audit
// param types). `./core`, `./indexes` and `./adapters/drizzle/indexes` reach
// none of those shapes and are unaffected.
//
// D.1 review fix (finding D1-R1-05): `.` (the package root) now exports
// `EdgeCardinalityAxisRef` and `EdgeCardinalityDirection` directly — the two
// types `EdgeCardinalityDeclaration` (already public from `.`) and
// `CardinalityErrorDetails.direction` (already public from `.`) are built
// from — so a consumer of `"@nicia-ai/typegraph"` alone can name either
// field's type without a subpath import. `.`'s debt therefore DROPS 391→389
// (two names move from forgotten to real exports); every OTHER entrypoint is
// unaffected, since none of them re-exports either name and both remain
// forgotten there exactly as the paragraph above describes.
//
// Transaction-scoped policy delete (EC1-R1-01 fix): `TransactionRuntime` and
// `StoreRuntime` both gain a `deleteNodeWithPolicy` member typed over
// `NodeDeletePolicy` (`store/operations/node-write-pipeline.ts`) so merge
// apply's node delete can bind to the SAME transaction's buffered hook
// runner and attempt instead of a freshly-built Store-scoped context. This
// is exactly the B8 `[STORE_RUNTIME]`-reachable set (`.`, `./graph-merge`,
// `./interchange`, `./profiler`, `./provenance`, `./sqlite/local`,
// `./postgres/pglite`), each +1 for `NodeDeletePolicy` on top of the D.1 baseline: `.` 389→390,
// `./graph-merge` 734→735, `./interchange` 717→718, `./postgres/pglite`
// 714→715, `./profiler` 719→720, `./provenance` 725→726, `./sqlite/local`
// 714→715. No other entrypoint renders `TransactionRuntime`/`StoreRuntime`,
// so no other entrypoint moved.
//
// Composition relation (partOf/hasPart via/partSide, issue plan-E-a): every
// entrypoint that reaches `KindRegistry`, `ExtensionOntologyRelation`, or the
// registry closures picks up `CompositionPartSide` (a `@public` named export)
// and, where the entrypoint also surfaces `RegistryClosures` internals,
// `CompositionPair` / `CompositionRelation` as forgotten exports. `./indexes`
// and `./adapters/drizzle/indexes` never reach the registry and are
// unaffected.
//
// Typed subsumption batch (C.1/C.2/Q3/C.3): measured, not assumed — every
// added name below was confirmed against a merge-base build run through this
// same script (a temporary unconditional dump of each entrypoint's forgotten-
// export set, diffed line by line against this batch's set, then reverted).
//
// `.` gains exactly the 13 new declarations this batch introduces, all
// reachable only through `subClassOf`/`equivalentTo`/`sameAs`'s new generic
// signatures, none of them exported directly at the root: `TypedOntologyRelation`,
// `SubClassOfCheck`, `EquivalentToCheck`, `IncompatibleKeys`, `LiteralKeysOf`,
// `StructuralSubtypeMismatch`, `META_EDGE_SUB_CLASS_OF`,
// `META_EDGE_EQUIVALENT_TO`, `META_EDGE_SAME_AS`, `PolymorphicNodeType`,
// `AliasExpansionAxis`, `AliasNodeType`, `SubsumptionAffected` (388 → 401).
//
// The six Store-bearing entrypoints that render `QueryBuilder`/`Store`
// without naming the ontology relation functions themselves (`./interchange`,
// `./profiler`, `./graph-merge`, `./provenance`, `./sqlite/local`,
// `./postgres/pglite`) each gain only the four names reachable through the
// widened `from`/`to`/`fromDynamic`/`toDynamic` overloads and `QueryStart`'s
// new `expansion` field — `AliasExpansionAxis`, `AliasNodeType`,
// `PolymorphicNodeType`, `SubsumptionAffected` (+4 apiece) — never the
// `subClassOf`/`equivalentTo`/`sameAs`-only names above, since none of these
// six re-exports those functions. No other entrypoint moves: `./backend`,
// `./core`, `./schema`, `./graph-extension`, `./indexes`, and the five
// `./adapters/drizzle/*` entrypoints render neither the ontology relation
// functions nor a `QueryBuilder`, so none of this batch's new vocabulary
// becomes reachable there. `./schema` gains `isTypeLevelSubtype` and
// `projectTypeVisible` as DIRECT exports (visible in the api report diff, not
// this ledger), so its forgotten-export debt is unaffected.
//
// C13-R2-01 follow-up: `SubsumptionAffected` gained a new private helper,
// `OntologyTypeErased` (whether `G["ontology"]` has lost its `const`-inferred
// tuple shape — see its docblock in `src/query/builder/types.ts`), reachable
// through the exact same seven entrypoints as `SubsumptionAffected` itself
// and no others, for the same reason: `.` (+1: 401 → 402) and the six
// Store-bearing entrypoints above (+1 apiece: `./interchange` 717 → 718,
// `./profiler` 719 → 720, `./graph-merge` 734 → 735, `./provenance`
// 725 → 726, `./sqlite/local` 714 → 715, `./postgres/pglite` 714 → 715).
//
// Identity transition log batch: `StoreRuntime.identityContext()` (added
// earlier in this feature, alongside the transition log's relations and
// `IdentityTableNames`/`SqlTableNames` gaining `identityTransitions` /
// `identityTransitionRetention`) was never reconciled against this ledger —
// `pnpm api-report:update` had not been run since. It returns
// `IdentityServiceContext<G>`, an internal (non-exported) type that itself
// names `PlainNodeRef`; neither is exported directly anywhere, including the
// root. Both become newly reachable, and so newly forgotten-exported, at
// every entrypoint whose full `StoreRuntime` member set renders: `.`
// (388→390), `./interchange` (709→711), `./profiler` (711→713),
// `./graph-merge` (726→728), `./provenance` (717→719), `./sqlite/local`
// (706→708), `./postgres/pglite` (706→708) — +2 apiece, `IdentityServiceContext`
// and `PlainNodeRef` exactly. The `identityTransitions`/`identityTransitionRetention`
// string fields introduce no new symbol names, so they move no entrypoint's
// debt on their own. Gate: every moved entrypoint's delta is exactly +2,
// both added names are `IdentityServiceContext`/`PlainNodeRef`, and no other
// entrypoint moved.
//
// This is internal-convenience debt, not a user-facing requirement (G1R3-05):
// `identityContext()`'s two consumers, replay and prune, are plain functions
// over `IdentityServiceContext<G>`. The release batch below evaluates, and
// declines, both ways of retiring these seven +2 entries — see that batch's
// own comment for the reasoning; this one stays permanent, not staged.
//
// `ensureSchema`'s `historyEnabled` extra moved off the public
// `SchemaManagerOptions` (G1R3-04) onto an unexported `EnsureSchemaInternalOptions`
// that only `ensureSchemaInternal` (imported directly by `store.ts`, never
// re-exported) accepts, so it renders at no entrypoint at all — no ledger
// entry to update for that change.
// `IdentityDecisionProvenance` (+1 on `./interchange`, `./postgres/pglite`,
// `./profiler`, `./provenance` and `./sqlite/local`): the graph-merge identity
// apply threads the governing merge decision through
// `StoreRuntime.applyIdentityMergeAtTarget`, so the runtime port's declared
// parameter type renders at every entrypoint that projects `StoreRuntime`.
// Naming the type on the port is the point — a structurally-inlined copy of the
// decision shape would be a second spelling of "what a governing decision is".
// It is exported from the package barrel and from `src/graph-merge/index.ts`,
// which is what keeps `.` and `./graph-merge` off this list; the five above
// each carry their own narrow barrel that has no business re-exporting an
// identity type, so their entry is the honest cost of naming it on the port.
//
// `./graph-merge` nets DOWN: the identity reconciliation surface
// (`IdentityReconciliationOptions`, the conflict/decision types, the
// staged-assertion shapes a policy callback receives, the pairing scope) is
// exported deliberately from `src/graph-merge/index.ts` rather than left as
// debt, which retires more forgotten exports than the port adds.
//
// Ruling (2026-09-09): the five `IdentityDecisionProvenance` entries above
// stay PERMANENT debt, not retired. The only retirement this ledger's own
// discipline allows is re-exporting the type from each of those five narrow
// barrels — `./interchange`, `./postgres/pglite`, `./profiler`,
// `./provenance`, `./sqlite/local` — purely to move a count, which is
// exactly the "export machinery invented to avoid debt" this file's header
// forbids and the identical `IdentityServiceContext` / `PlainNodeRef` ruling
// two comments below already declined for the same reason. None of those
// five barrels has a type-surface reason of its own to name a merge
// decision's shape.
//
// Release batch, publishing replay and archival restore (this had not been
// run since the `identityContext()` batch above landed either, so `.`'s
// baseline already carried that batch's `IdentityServiceContext` /
// `PlainNodeRef`, unmentioned by name below because this batch changes
// neither count on `.`):
//
// `IdentityFacade` gains `replay` / `transitionsOf`
// (`IdentityReplay`, `IdentityReplayOptions`, `IdentityReplayStep`,
// `IdentityTransition`, `IdentityTransitionCause` in their signatures, all
// exported deliberately from the package barrel), and
// `StoreRuntime` gains the archival-restore port members
// `readIdentityTransitionPageAtTarget` / `importIdentityTransitionsAtTarget`
// (`IdentityTransitionCursor` / `IdentityTransitionTransfer`, internal
// wire-transfer shapes owned by `transition-log.ts`, exported nowhere).
// That is seven names, and every one of them renders at the six
// Store-bearing entrypoints exactly as `IdentityDecisionProvenance` already
// does two comments up — `./interchange`, `./profiler`, `./graph-merge`,
// `./provenance`, `./sqlite/local`, `./postgres/pglite`, +7 apiece — because
// none of those narrow barrels re-exports the five deliberately-public
// names, the same "has no business re-exporting an identity type" reasoning
// that already applies to `IdentityDecisionProvenance` there.
//
// `.` moves only +2: the five deliberately-exported names are exported AT
// `.` itself, so they are not forgotten there — only the two never-exported
// transfer types (`IdentityTransitionCursor`, `IdentityTransitionTransfer`)
// newly render, through the same `StoreRuntime` reachability
// `IdentityServiceContext` / `PlainNodeRef` already established.
//
// Narrowing `identityContext()`'s declared return (the retirement path this
// file's own comment above named as "expected") was evaluated and NOT
// taken: `identityContext()`'s sole consumer, `pruneIdentityTransitionsForContext`,
// hands the context straight to `runIdentityMutation` — the identity
// module's central mutation runner, called from every write site — so
// narrowing the return would cascade into re-typing `runIdentityMutation`
// across the whole module, exactly the kind of internal-semantics change
// this release is scoped not to make. Exporting `IdentityServiceContext` /
// `PlainNodeRef` publicly (this file's other named option) was also
// declined: `pruneIdentityTransitions`'s own public signature (`store:
// Store<G>`, an options bag) never mentions either type, so exporting two
// backend-shaped internal types would add public surface with no caller who
// needs it, purely to move a ledger number. That debt stays as documented,
// unretired.
//
// TransactionBackend gaining LineageBackend batch. `TransactionBackend`
// gained `LineageBackend` (a `Pick<GraphBackend, "lineage">`, mirroring the
// pre-existing `CatalogBackend`) so `tx.lineage` is type-accessible on a
// transaction handle the same way `tx.catalog` already was — the runtime fix
// this ships alongside threads a profile-supplied `lineage` onto a
// transaction-scoped backend in both dialects, which was previously silently
// dropped. `LineageBackend` is directly exported only from `./backend`, the
// module that defines it; every OTHER entrypoint that renders
// `TransactionBackend` at all (its type literal spells `LineageBackend` out
// as one of its intersection members) reaches `LineageBackend` only through
// that reachability, so the rule is simply: every entrypoint that renders
// `TransactionBackend` and does not itself export `LineageBackend` gains
// forgotten-export debt for it, by exactly +1. Fourteen entrypoints render
// `TransactionBackend` without exporting `LineageBackend` and so move: `.`,
// `./adapters/drizzle/engine`, `./adapters/drizzle/postgres`, `./adapters/
// drizzle/postgres/pglite`, `./adapters/drizzle/sqlite`, `./adapters/
// drizzle/sqlite/libsql`, `./adapters/drizzle/sqlite/local`,
// `./graph-merge`, `./interchange`, `./postgres/pglite`, `./profiler`,
// `./provenance`, `./schema`, and `./sqlite/local`. `LineageMembers`/
// `LineageDelta`/`EntityKey`/`EngineRevision` were already counted as
// forgotten exports at every one of those fourteen wherever
// `GraphBranch`/`GraphBackend.lineage` reached them (see the batch above),
// so `LineageBackend` is the only symbol this step adds to any of their
// counts. Gate: every moved entrypoint's debt increased by exactly 1, and
// no other entrypoint moved.
// Post-rebase batch. `feat/lineage-capability` added `GraphBranch.
// forkRevision?: EngineRevision` (the pruned-diff step) before rebasing onto
// a `main` that had independently added `GraphBranch.close` (the forked
// working-copy strategy) — both branches touched the same object-type
// literal. The source conflict was resolved correctly (`GraphBranch` now
// carries both members), but this ledger and every `etc/*.api.md` were
// carried forward from `main`'s side of that same conflict, which predates
// `forkRevision` entirely — silently discarding the forgotten-export debt
// the lineage branch's own commits had already earned and accounted for.
// This run restores it: exactly 14 entrypoints move, every one by the same
// +4 (`EngineRevision` plus the three other lineage types it makes newly
// reachable wherever `GraphBranch` or `GraphBackend.lineage` renders),
// confirmed by comparing against the two entrypoints whose `.api.md` TEXT
// also changed (`./graph-merge` for `forkRevision` itself, `./adapters/
// drizzle/engine` for this step's own `CreateBaseSchemaMembersDeps.
// sinceIndexDdl` — a plain tuple of primitives, so it earns no forgotten
// export of its own and contributes nothing beyond the shared +4). Gate:
// every moved entrypoint's debt only increased, and by the same amount.
// LineageSession batch. `LineageMembers.revision`/`.changesSince` each gained
// a `session: LineageSession` parameter (the connection a read runs on,
// replacing a dead identity comparison `assertTargetUnchanged` used to make
// against a bag that took no session argument at all). `LineageSession` is
// directly exported only from `./backend`, the module that defines it;
// every other entrypoint that renders `LineageMembers` at all now also
// renders `LineageSession` inside its two members' signatures, so the SAME
// fourteen entrypoints the `LineageBackend` batch above named move again,
// each by exactly +1: `.`, `./adapters/drizzle/engine`, `./adapters/
// drizzle/postgres`, `./adapters/drizzle/postgres/pglite`, `./adapters/
// drizzle/sqlite`, `./adapters/drizzle/sqlite/libsql`, `./adapters/
// drizzle/sqlite/local`, `./graph-merge`, `./interchange`, `./postgres/
// pglite`, `./profiler`, `./provenance`, `./schema`, and `./sqlite/local`.
// Gate: every moved entrypoint's debt increased by exactly 1, no other
// entrypoint moved, and `./backend`'s own `.api.md` is the only one whose
// TEXT diff adds a new top-level type (`LineageSession` itself) rather than
// only touching `LineageMembers`'s two member signatures and the `lineage`
// registry entry's `accesses` field.
//
// Recorded read source seam batch: `ExternalRecordedReadSource` and the
// built-in capture binding's type both gained `source`/`predicate` members
// (an intersection with the newly-public `RecordedReadSource`), whose
// signatures reference `RecordedInstantParts` — a shape `core/temporal.ts`
// already exported by name but no entrypoint had rendered before. `.`
// directly exports `RecordedReadSource` and `RecordedSourceTable` now
// (dropping the old unexported `RecordedReadSource` union from its own
// forgotten set) while picking up `RecordedInstantParts` as a forgotten
// export, netting zero (394 → 394, a different symbol set behind the same
// count, hence a new SHA). The six entrypoints that mirror `.`'s surface
// without directly exporting `RecordedReadSource`/`RecordedSourceTable`
// (`./graph-merge`, `./interchange`, `./postgres/pglite`, `./profiler`,
// `./provenance`, `./sqlite/local`) each gain both types as forgotten
// exports, +2 apiece.
//
// Engine-native recorded time batch: `RecordedInstantParts` (already
// forgotten export debt everywhere it rendered) became a discriminated union
// of two new shapes, `TypeGraphRecordedInstantParts` and
// `EngineRecordedInstantParts`, and the recorded read binding union
// (`RecordedReadBinding`) gained a third member, `EngineRecordedReadSource` —
// both reachable wherever `RecordedInstantParts`/`RecordedReadBinding`
// already rendered. `StoreCore` (reachable from `.` via `Store`) also gained
// `recordedTimeOwnership: RecordedTimeOwnership`, a fourth new forgotten
// export at the same site. The seven entrypoints that already rendered
// `RecordedInstantParts` (`.`, `./graph-merge`, `./interchange`, `./postgres/
// pglite`, `./profiler`, `./provenance`, `./sqlite/local`) each move by
// exactly +4. Gate: every moved entrypoint's debt increased by exactly 4, no
// other entrypoint moved, and no bundled backend's own `.api.md` TEXT gains a
// new top-level type beyond the two already-public seam types
// (`EngineRecordedTimeMembers`/`EngineRecordedRevision`, added in the prior
// commit) referencing `RecordedInstantParts`'s new shape indirectly.
const FORGOTTEN_EXPORT_DEBT: Readonly<Record<string, ForgottenExportDebt>> = {
  // Roadmap F (meta-edge removal): removing the public `InferenceType`
  // union (never re-exported from most entrypoints, only pulled in
  // transitively through `MetaEdgeProperties`/`SerializedMetaEdge`) dropped
  // exactly one forgotten export apiece from every entrypoint below that
  // saw its count change under THIS ONE batch — Roadmap F only ever
  // lowered a count, never raised one. That is not a standing guarantee
  // for the ledger as a whole: later batches below (Item E.2 among them)
  // document counts this ledger RAISES, each with its own gate on the
  // exact delta and the exact new names responsible.
  //
  // Item E.2: `CompositionExistence` (the `existence: "optional" | "required"`
  // union) is a new public type, re-exported directly only from `.` and
  // `./ontology` (alongside its existing sibling `CompositionPartSide`).
  // Every OTHER entrypoint below reaches it only transitively — through a
  // public signature that names `CompositionOptions`/`OntologyRelation`/
  // `CompositionPair`-derived shapes it never itself exports — so it
  // registers as a NEW forgotten export everywhere those signatures are
  // reachable (+1 apiece). A few entrypoints (`./backend`,
  // `./adapters/drizzle/*`, `./adapters/drizzle/postgres/pglite`,
  // `./adapters/drizzle/sqlite/local`, `./adapters/drizzle/sqlite/libsql`,
  // `./adapters/drizzle/engine`) also newly forgotten-export
  // `CompositionPartSide` for the first time at +1 each (it was already
  // reachable at every OTHER entrypoint below before this lane), because
  // the new `ConstraintFenceViolation.compositionExistence` member and the
  // `ReadConstraintFenceViolationsParams`-adjacent surface it rides in on
  // make the composition-relation types reachable from those backend
  // entrypoints for the first time.
  // `CompositionWholeRef` and `NodeCreateOptions` are exported directly from
  // `.` (see `src/index.ts`), so neither registers as forgotten here — the
  // debt is back to its pre-E.2 baseline for this entrypoint specifically.
  ".": {
    count: 410,
    sha256: "bb66b071623f7b108adbc99c1d640e6d3aa47f29f1645a38480cca0c24f2f06f",
  },
  "./adapters/drizzle/engine": {
    count: 327,
    sha256: "7a5a67c6d20c0088e8c8da016acf611805a90c4ce3df47f1934b20cabf1173a2",
  },
  "./adapters/drizzle/indexes": {
    count: 24,
    sha256: "6c11a8d2c13c886a2d6473f8af99d9c4988c7bbfe97545a6a6f748cdd18bf6d8",
  },
  "./adapters/drizzle/postgres": {
    count: 254,
    sha256: "eed0e84b48cc5910f091832e3e5e6c4031006a1fedc497814ddae036b6b006a7",
  },
  "./adapters/drizzle/postgres/pglite": {
    count: 258,
    sha256: "e581c1e654750b8ecc5ab985cdc9a0bf4f174652ad49f26ab286204a0ae61ae1",
  },
  "./adapters/drizzle/sqlite": {
    count: 255,
    sha256: "14c5634ea4d61739ccbf0247418e24d528788902293a0ae0064c5356175806b3",
  },
  "./adapters/drizzle/sqlite/libsql": {
    count: 258,
    sha256: "53c25a59b9a29346cb43cbc52e4b0056ac1fa8a1e6c78487d0a28c843f098e51",
  },
  "./adapters/drizzle/sqlite/local": {
    count: 258,
    sha256: "53c25a59b9a29346cb43cbc52e4b0056ac1fa8a1e6c78487d0a28c843f098e51",
  },
  "./backend": {
    count: 22,
    sha256: "7e3362491e07c2eb5729cb621a7994eebb2f19b6585859d9bb1abbe7f854af1b",
  },
  "./core": {
    count: 73,
    sha256: "558fb671c7c7fc1053c0bc22a807110516596cd49364a1804abcce8d2878d621",
  },
  "./graph-extension": {
    count: 20,
    sha256: "f88c3ebb710441aa204483f98147921b40dd8ba978c7b87b803c561c82137638",
  },
  // MergePlanReadContext derives its read-only surface from the runtime method
  // lists: EDGE_TEMPORAL_READ_NAMES, IDENTITY_READ_NAMES, and NODE_READ_NAMES.
  // These three implementation constants are referenced, not public exports.
  "./graph-merge": {
    count: 758,
    sha256: "4b2c41546be6c05a88c6b1e813399e77546616ca72c140eb938bcec09ba1b58e",
  },
  "./indexes": {
    count: 46,
    sha256: "5a43d419097711d242c6208632e7e498374a5977eb10a7faba904b10e13f35cd",
  },
  "./interchange": {
    count: 743,
    sha256: "e9f06c93667ccf88527220336bd8cf8a3eb8fdaeaa6004675552271882f5e234",
  },
  "./postgres/pglite": {
    count: 740,
    sha256: "224d36d55ac1e109c8f78066667a8eab48773c0bdde9e9454502c8211746bca9",
  },
  "./profiler": {
    count: 745,
    sha256: "52deeee74965fd90d8ff982efbf43cca8627fc775b52fd2e14e3b79385fbd77b",
  },
  "./provenance": {
    count: 751,
    sha256: "6625194f4f93f356297df62d9fef7bbc9d7d605b09dcdd3985f0b3727f02aa40",
  },
  // Identity transition log: `ensureSchema`'s inline `{ preloaded?: ... }`
  // options type was extracted into the named (but non-exported)
  // `EnsureSchemaPreloadedOptions` alias so `EnsureSchemaInternalOptions`
  // could extend it for `ensureSchemaInternal` (the new export `store.ts`
  // calls directly with `historyEnabled`, never re-exported from a public
  // entry point). An anonymous inline type never registers as a forgotten
  // export; a named non-exported one used in `ensureSchema`'s public
  // signature does. +1, only on `./schema` — the sole entrypoint that
  // names `ensureSchema`.
  "./schema": {
    count: 283,
    sha256: "d151d64d59d863a37d75027fe51e40ae149a0f2fe122f5ff6751dcc9971a35c8",
  },
  "./sqlite/local": {
    count: 740,
    sha256: "224d36d55ac1e109c8f78066667a8eab48773c0bdde9e9454502c8211746bca9",
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
