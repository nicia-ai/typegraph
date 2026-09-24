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
// bulkFindEdgesTo adds BulkFindEdgesToParams and BulkFindEdgesToResult to the
// six Store-bearing secondary entrypoints (+2 each). Both are directly
// exported from the root entrypoint; no other symbol sets changed.
// Set-oriented read APIs add seven root-exported supporting types to
// `StoreCore`: CheckedReadScope, EdgeReadWindow, NeighborOrderField,
// NeighborReadOptions, NeighborResult, OneStatementBatchResults, and
// OneStatementBatchableQuery. The same six Store-bearing secondary
// entrypoints render those names without exporting them directly (+7 each).
// Composable set-read follow-up. The root directly exports the six new public
// helper types (`NeighborNodeOrderField`, `NeighborOrder`, `NeighborRead`,
// `SubgraphRead`, `EmbeddableOneStatementRead`, and
// `ExecutableOneStatementRead`), while the
// compatibility-preserving optional-boundary Store construction makes six
// private helper names newly reachable there (+6). The six Store-bearing
// secondary entrypoints do not re-export the six public helper names, so they
// gain those six plus the same six private helpers (+12 each). No other
// entrypoint's forgotten-export set changes.
// Scoped batch reads replace the public `*Query` pairs with a single
// `BatchReadBuilder` callback surface. The four secondary Store entrypoints
// that can re-export its two public helper types lose the three superseded
// forgotten names (`NeighborRead`, `SubgraphRead`, and
// `ExecutableOneStatementRead`). The bundled local-backend entrypoints also
// lose one superseded helper without re-exporting the new helpers: importing
// Store types there would unnecessarily expose the Store dependency graph
// through their adapter aliases.
// Query DSL phase 1/2 contract repair adds twelve private helper names to the
// root and the six Store-bearing secondary entrypoints (+12 each). Seven
// (`AggregateAliasMap`, `AggregateFieldResult`, `AliasSchemaValue`,
// `AliasValue`, `FieldResult`, `PropertyValue`, `WithAliasOptionality`) carry
// schema-aware aggregate result inference; four (`EqualityOperand`,
// `MembershipOperand`, `NullFieldAccessor`, `ObjectComparisonAccessor`) carry
// the corrected predicate operand/accessor contracts; and
// `OneStatementBatchReads` preserves batchOnce tuple and readonly-array result
// inference. These are implementation helpers behind exported fluent APIs,
// not independently useful contracts, so exporting them merely to erase
// measured forgotten-export debt would enlarge the package surface without a
// caller use case. No names were removed and no other entrypoint moved.
// Query DSL phase 3 adds typed database expressions and projection queries.
// Thirty-six private representation/inference helpers become reachable from
// every Store-bearing surface: `AggregateExpressionNode`, `AggregateOperator`,
// `AliasExpressions`, `ArithmeticExpressionNode`, `ArithmeticOperator`,
// `BooleanExpressionNode`, `CoalesceExpressionNode`, `ComparisonExpressionNode`,
// `ConditionalExpressionNode`, `DatabaseExpressionNode`,
// `DatabaseExpressionPredicate`, `DatabaseJsonValue`, `DatabaseLiteral`,
// `ExistsSubqueryExpressionNode`, `ExpressionComparisonOperator`,
// `ExpressionMetadata`, `ExpressionObjectChildren`,
// `ExpressionProjectionEntries`, `ExpressionProjectionEntry`,
// `ExpressionSubqueryHelpers`, `ExpressionSubqueryRelation`,
// `ExpressionValue$1`, `FieldExpressionNode`, `IsUnion`,
// `LiteralExpressionNode`, `NotExpressionNode`, `NullCheckExpressionNode`,
// `NumericConversionExpressionNode`, `OneStatementReadProvenance`,
// `OuterReferenceExpressionNode`, `ParameterExpressionNode`,
// `ProjectedExpressionSubqueryRelation`, `ScalarExpressionSubqueryRelation`,
// `ScalarSubqueryExpressionNode`, `UndefinedWhenNullish`, and
// `UndefinedWhenOptional`. The six secondary Store entrypoints additionally
// reach seven public root exports they do not re-export (`DatabaseExpression`,
// `DatabaseProjection`, `ExecutableProjectionQuery`, `ExpressionAliasContext`,
// `ExpressionValue`, `ProjectionResult`, `QueryExpressionContext`), producing
// their exact +43 delta. The root instead gains twenty private helpers used by
// its exported expression factories and inference: `Comparable`,
// `ComparableExpression`, `LiteralResult`, `MergeAliasMaps`,
// `MergeEdgeAliasMaps`, `NonNull`, `NullIfEitherUndefined`,
// `NumericExpression`, `OrderedComparable`, `ParameterValue`, `coalesce`,
// `countDistinct_2`, `count_2`, `isNotNull`, `isNull`, `literal`, `not`,
// `parameter`, `toNumber`, and `when`, producing its exact +56 delta. These
// helpers are implementation details behind the exported fluent surface; no
// forgotten name was removed, and exporting them would add API without an
// independent caller contract.
// Phase 4 adds eleven internal relation contract names behind the root's public
// fluent API: AggregateRelationFields, CompatibleRelationProjection,
// DerivedRelation, RelationAst, RelationColumn, RelationDefinition, RelationOrder,
// RelationProvenance, RelationSource, RelationState, and SetRelation. Root debt
// is 476 -> 487. The six Store-bearing secondary entrypoints also reference the
// root-only public ExecutableRelationQuery, PreparedBindings,
// PreparedParameterDeclaration, RelationColumnContext, RelationProjection, and
// RelationProjectionResult, giving each an exact +17 delta. No old names were
// removed, and these internal constructor/compiler types are not independent APIs.
// Phase 6 adds two internal qualified-path inference helpers at the root:
// RequiredRecursiveAliasValue and ResolvePathFormat (487 -> 489). The six
// Store-bearing secondary entrypoints additionally reach the root-exported
// BatchOnceOptions and five QualifiedRecursivePath* types, plus those same two
// helpers, for an exact +8 each. These names are the implementation graph behind
// the public opt-in batch option and qualified recursive-path result; the public
// caller types are exported at the root, while duplicating them across unrelated
// entrypoints would enlarge those surfaces. No forgotten name was removed.
// Ordered scalar collection adds one private factory name, `collect`, to the
// root expression object's inferred public shape (+1: 489 -> 490). The root
// directly exports its caller-facing `CollectOrder` type. The six secondary
// Store-bearing entrypoints render that type through the same expression
// surface without re-exporting it, so each gains `CollectOrder` instead (+1).
// No other forgotten-export set changes: the aggregate AST metadata and
// collection element metadata reuse types already present in those graphs.
// Splitting collection aggregation into its own public AST discriminant adds
// the internal `CollectExpressionNode` to the root and the same six
// Store-bearing secondary entrypoints (+1 each). `CollectOptions` is exported
// directly at the root and does not propagate into the secondary declaration
// graphs. Removing `"collect"` from `AggregateOperator` and `orderBy` from
// `AggregateExpressionNode` changes existing declarations without changing
// the forgotten-name set. No other entrypoint changes.
// Recorded revision requests add three public root types:
// `RecordedRevisionRequest`, `HistoryTransactionContext`, and
// `MeasurableHistoryTransactionContext`. The Store-bearing `./provenance`,
// `./sqlite/local`, and `./postgres/pglite` entrypoints render those root-only
// types transitively, so each gains exactly those three forgotten exports.
// The root names all three directly and gains no forgotten-export debt.
// Explicit multi-kind sources add FieldCategory to the root's reachable helper
// graph. Store-bearing secondary entrypoints also reference CommonPropertyKeys
// and NodePropsFor, which are exported by the root rather than repeated on each
// secondary surface. IsUnion is now shared with expression subqueries and keeps
// its existing forgotten-export name. Measured additions: +1 root, +3 on the
// six Store-bearing secondary entrypoints below; other surfaces are unchanged.
// Adopted schema evolution adds directly exported plan, option, outcome, and
// timeout types at their defining barrels. The API extractor also renders
// implementation-only owner/payload and backend adoption types transitively
// through Store and adapter signatures. These are booked as forgotten-export
// debt rather than widened as standalone package exports: they are not
// callable entrypoints or useful authoring contracts. After the six public
// plan/option types are directly exported from the root, root debt rises by
// four;
// Store-bearing secondary surfaces rise by six; backend adapter surfaces rise
// by two (one for the adoption result), and schema/engine surfaces by one.
// `branchForEvolution` is a direct graph-merge export; its transitive
// `EvolutionPlan` and Store evolution option types account for the additional
// graph-merge debt. The exact fingerprints below gate every changed surface.
// Planned evolution (#705) changes the type graph reachable through StoreEvolution:
// SchemaIdentity and the discriminated EvolutionRequirement union become named
// root/schema exports, while adapter authoring gains SchemaProvisioning and
// AdoptedSchemaWriteTransaction. The remaining entrypoint-specific changes below
// are exact symbol-set fingerprints, not a relaxed count-only allowance.
// Ordered record collections export CollectRecordFields, CollectedRecord, and
// CollectRecordOperand directly from the root. Six Store-bearing secondary
// entrypoints reach only CollectRecordOperand transitively, adding exactly
// that one forgotten name to each fingerprint below. Removing that name from
// each measured symbol set reproduces its previous fingerprint.
// Partitioned top-N introduces TopPerPartitionRelation as a transitive
// forgotten export at the root. Six Store-bearing secondary entrypoints also
// reach TopPerPartitionOptions and TopPerPartitionOrder without exporting them
// directly. Removing these exact new names from each measured symbol set
// reproduces its previous fingerprint; all other entrypoints are unchanged.
// Shared capability upgrades add ContributionScope and node-candidate query
// contracts to Store-bearing entrypoints, while endpoint-set conformance adds
// its fixture types and a bundle-member helper. These declarations are
// intentionally public or transitively reachable from public signatures; the
// updated hashes below record the exact measured name sets from this run.
// Array membership and tuple cursor predicates add their AST nodes to the
// public query graph. The root also reaches their operand helper types; each
// Store-bearing secondary entrypoint reaches the two predicate node types.
// Resolved node update batch contracts become reachable through the six
// Store-bearing secondary entrypoints. The fingerprints below record the
// complete measured symbol sets after that portable batch surface was added.
// Recorded heterogeneous node upserts add the public transaction input/result
// types at the root and make the backend lowering contracts reachable through
// GraphBackend. The backend barrel exports those contracts directly; the
// remaining entrypoints retain their deliberately narrower public surfaces,
// so the exact transitive name sets are booked here rather than widened.
// Graph-extension introspection now exports its function and two result types
// from the root, removing those three names from root forgotten-export debt.
const FORGOTTEN_EXPORT_DEBT: Readonly<Record<string, ForgottenExportDebt>> = {
  ".": {
    count: 498,
    sha256: "ed9b8f4a81bd6114df06a55432f5f7328d6c1782ed01b443a0ad3311b6ced948",
  },
  "./adapters/drizzle/engine": {
    count: 336,
    sha256: "093a591827631c8bf0d39d0545fdafb5146a2ffa4ef0e7bc3a13e3b788349665",
  },
  "./adapters/drizzle/indexes": {
    count: 24,
    sha256: "6c11a8d2c13c886a2d6473f8af99d9c4988c7bbfe97545a6a6f748cdd18bf6d8",
  },
  "./adapters/drizzle/postgres": {
    count: 265,
    sha256: "f2ff4682146d644371699c7401b7669cce137b8d72573065614cceecd3330b9f",
  },
  "./adapters/drizzle/postgres/pglite": {
    count: 269,
    sha256: "9b43d805eff4a13e93d019b4eda078d9f7f87623667d11be5121eda8fdb81e0f",
  },
  "./adapters/drizzle/sqlite": {
    count: 266,
    sha256: "bd8ccc0d561def033a698b4debd310a7474b91cbc84c1906e9505f33f7208b88",
  },
  "./adapters/drizzle/sqlite/libsql": {
    count: 269,
    sha256: "84947a220caf1ca427203f54504c2abea1c76930ef6a68a886fc1a3936020343",
  },
  "./adapters/drizzle/sqlite/local": {
    count: 269,
    sha256: "84947a220caf1ca427203f54504c2abea1c76930ef6a68a886fc1a3936020343",
  },
  "./backend": {
    count: 18,
    sha256: "febe6415eed00c5e97431d9a311d9a443cebd1015c2c053ac777d1bb245dbadd",
  },
  "./core": {
    count: 72,
    sha256: "bf73c4f71677d2b3ec2e36bfd37e9ede5c3f57377fc923f0df2eb1b500cfc84d",
  },
  // ExtensionIndexWhere makes NullCheckOp reachable through this entrypoint.
  "./graph-extension": {
    count: 17,
    sha256: "4b4cedb3e4d62be38f1b9d82e55a7aeaca681847dd99285e13a524064e9c2ab3",
  },
  // MergePlanReadContext derives its read-only surface from the runtime method
  // lists: EDGE_TEMPORAL_READ_NAMES, IDENTITY_READ_NAMES, and NODE_READ_NAMES.
  // These three implementation constants are referenced, not public exports.
  "./graph-merge": {
    count: 866,
    sha256: "2d6663245e0507451946b8519cdcac3f7b4b185c142e9b1ee27c25d74f91fb49",
  },
  "./indexes": {
    count: 46,
    sha256: "5a43d419097711d242c6208632e7e498374a5977eb10a7faba904b10e13f35cd",
  },
  "./interchange": {
    count: 849,
    sha256: "f0a15151233e52449f14610067263b04e2e6e63147318287accfd78e326a1dc0",
  },
  "./postgres/pglite": {
    count: 855,
    sha256: "f09819a0eeded08fb10c68db7d6ae17cafa005dcba8b7863fa6ac4a55887542f",
  },
  "./profiler": {
    count: 851,
    sha256: "8e9639ae422506df342bb7c6ffeabfd2524eeef316795d107e89de4e838f844a",
  },
  "./provenance": {
    count: 864,
    sha256: "27ee1b7e293ae2f6fe2862fb4d754445e86e60c82955b3cfa5e7453013a06af1",
  },
  "./schema": {
    count: 288,
    sha256: "588e9ab6d547e809644ca2543f3268c45bcedb2c485b0c3e9c4f0658b5857539",
  },
  "./sqlite/local": {
    count: 855,
    sha256: "f09819a0eeded08fb10c68db7d6ae17cafa005dcba8b7863fa6ac4a55887542f",
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
