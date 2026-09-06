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
 * Write-fence batch (WS5 B10): the same 14 entrypoints B1's
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
 * constructors, and `pessimisticLockDeclarationLine` are deliberately not
 * exported anywhere, so none of them can register as a forgotten export
 * either. Delta table (old → new, all +1): `.` 352→353, `./backend` 10→11,
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
const FORGOTTEN_EXPORT_DEBT: Readonly<Record<string, ForgottenExportDebt>> = {
  ".": {
    count: 388,
    sha256: "11f038ecdf42bbad583047a01c5b5106f226a42291f67f19d588448764a6cbeb",
  },
  "./adapters/drizzle/engine": {
    count: 320,
    sha256: "de637873ab980dde2778687f620ffbc5cef77e54e4d422050c0bb2dc181eee7d",
  },
  "./adapters/drizzle/indexes": {
    count: 24,
    sha256: "6c11a8d2c13c886a2d6473f8af99d9c4988c7bbfe97545a6a6f748cdd18bf6d8",
  },
  "./adapters/drizzle/postgres": {
    count: 246,
    sha256: "8c006f6a1e41393662c563d728e9a1ea8e37088c8b99d36141a4576a749baf5e",
  },
  "./adapters/drizzle/postgres/pglite": {
    count: 250,
    sha256: "202efb4305f220d6ff4cb3e0a9d8f1d7d99dbbc5b3233015745dd9d928a31924",
  },
  "./adapters/drizzle/sqlite": {
    count: 247,
    sha256: "22ef6d9483a40553b274996237ac3121560d8d88966c6e32003c1f97311f5872",
  },
  "./adapters/drizzle/sqlite/libsql": {
    count: 250,
    sha256: "17154fcd67efb82e904e7ed3fa57cc984114bdd75b7acaebb6ed5782d7f8c3cf",
  },
  "./adapters/drizzle/sqlite/local": {
    count: 250,
    sha256: "17154fcd67efb82e904e7ed3fa57cc984114bdd75b7acaebb6ed5782d7f8c3cf",
  },
  "./backend": {
    count: 17,
    sha256: "d7be94fc8aff9a4c4f7e304ce209aaf05f426ad2a8e808fa8b5066bfae75f19e",
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
    count: 718,
    sha256: "edb32f3b47436fd7c4e2f62c571c106553aa28f2c19bb7cd783f766832336961",
  },
  "./indexes": {
    count: 46,
    sha256: "5a43d419097711d242c6208632e7e498374a5977eb10a7faba904b10e13f35cd",
  },
  "./interchange": {
    count: 701,
    sha256: "9bf069f3f6a6f49d1bc2d6ef61d99c53cacc3fd4dc62d0ae966a1d66feaf9579",
  },
  "./postgres/pglite": {
    count: 705,
    sha256: "d6154cb7bf47cd8c18b885c603287a4bbc54c75da64e72b97bb81c4d50e3f18b",
  },
  "./profiler": {
    count: 703,
    sha256: "01d9f20480fae6d947b675be3cd6b71b6280563605ae3c8a61f569fd29466dde",
  },
  "./provenance": {
    count: 709,
    sha256: "824fef0bce05b867a867f66be6555931b5f3d074c43dd0ccd44a417d15268ae2",
  },
  "./schema": {
    count: 271,
    sha256: "98937d4bdad02494cdd60bf29a4287e543d9471a673d5846cb6796207d0f7448",
  },
  "./sqlite/local": {
    count: 705,
    sha256: "d6154cb7bf47cd8c18b885c603287a4bbc54c75da64e72b97bb81c4d50e3f18b",
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
