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
 * `./adapters/drizzle/engine`: its two head types (`SqlEngineProfile`,
 * `EngineAssemblyContext`) name the internal backend vocabulary — command
 * ports, row shapes, capability records — that this entrypoint deliberately
 * does not republish, so nearly all of it surfaces as forgotten-export debt
 * rather than a direct export, in family with the other adapter entrypoints.
 *
 * `EngineLateMembers.fence.runSchemaWriteTransaction`'s callback now
 * receives `InternalOperationBackend` instead of the narrower, `@internal`
 * `SchemaWriteTransactionBackend`, and the new sibling `schemaCommit` group
 * carries `commitSchemaVersionIfKindsEmpty` (typed over
 * `InternalOperationBackend`, `CommitSchemaVersionParams`, and
 * `SchemaKindEmptinessProbe` — all three already forgotten-referenced
 * elsewhere in this entrypoint). `SchemaWriteTransactionBackend` was this
 * entrypoint's only reference to that type, so it drops out of the
 * forgotten-export set entirely rather than adding to it (301 → 300).
 *
 * `createSqlBackend` now assembles the adapter literal itself, from the six
 * new `*Runtime` head types (`ContributionRuntime`, `IdentityRuntime`,
 * `GraphTemplateRuntime`, `BaseSchemaRuntime`, `IndexMaterializationRuntime`,
 * `KindRemovalRuntime`) plus `WriteFenceTarget` — each one a `Create*MembersDeps`
 * shape this entrypoint already forgotten-referenced through `profile.ts`'s
 * doc comments, now reached for real — plus `GraphTemplateExecute`, the named
 * function-type alias `graph-template-members.ts` introduces for its
 * `execute` member (300 → 324).
 */
const FORGOTTEN_EXPORT_DEBT: Readonly<Record<string, ForgottenExportDebt>> = {
  ".": {
    count: 367,
    sha256: "576b2d133f48d9c2fdd754ad72cc8b0d73741510de9950ce28b2392682e71c6b",
  },
  "./adapters/drizzle/engine": {
    count: 324,
    sha256: "810c84984aae97940d6332571f76f7b900041f8ecf3f5bb54fd10c9513c0efca",
  },
  "./adapters/drizzle/indexes": {
    count: 24,
    sha256: "6c11a8d2c13c886a2d6473f8af99d9c4988c7bbfe97545a6a6f748cdd18bf6d8",
  },
  "./adapters/drizzle/postgres": {
    count: 238,
    sha256: "9b2fe6c026beaa08869bfc963d251de1f99535953daf8786687e87e9a8b26b4e",
  },
  "./adapters/drizzle/postgres/pglite": {
    count: 242,
    sha256: "f37646ea0d377c4f60ade249aa71173c72aa2316eafddf94494ee006970ccb36",
  },
  "./adapters/drizzle/sqlite": {
    count: 239,
    sha256: "5b7e6b81efd7a2b27010c4a51a51b3f2600f82f91c653175767178584194de90",
  },
  "./adapters/drizzle/sqlite/libsql": {
    count: 242,
    sha256: "e22beac4a9343c68b3e51dfdcb095ddeb9e3f29e5a2792102948d257a1571215",
  },
  "./adapters/drizzle/sqlite/local": {
    count: 242,
    sha256: "e22beac4a9343c68b3e51dfdcb095ddeb9e3f29e5a2792102948d257a1571215",
  },
  "./backend": {
    count: 15,
    sha256: "13cf39b72b5f873ccd97dbabeac3c01b619eefe6c851bbab8375727c62566ee7",
  },
  "./core": {
    count: 72,
    sha256: "bf73c4f71677d2b3ec2e36bfd37e9ede5c3f57377fc923f0df2eb1b500cfc84d",
  },
  "./graph-extension": {
    count: 16,
    sha256: "1678650d02e0d9d7cc767ffbacbf163724c82fd4590c219b97d3dff85a6bf2f6",
  },
  "./graph-merge": {
    count: 690,
    sha256: "22c4c42c13480468b98cb406733d60388188fecf5f0b73d1e8d15972a451fd7b",
  },
  "./indexes": {
    count: 44,
    sha256: "c4d11e1ce334cf416c99e3d77bfd7f8722fe141fe12685a0c3b83099cc08290a",
  },
  "./interchange": {
    count: 676,
    sha256: "ae315aab063ce17afe3397d1f782d4c27e9774e70432300346a7fc4ede6b9b99",
  },
  "./postgres/pglite": {
    count: 680,
    sha256: "9ffda28a91364c5738c14ed1a31060ec991c78371a5fb78fe7bc0158f0bc4ff9",
  },
  "./profiler": {
    count: 678,
    sha256: "10703f06a798431ec22aac3f0a8bafcd0cb79a8b31bd3c5ebec9f13e3868ebe0",
  },
  "./provenance": {
    count: 684,
    sha256: "3647986b4142817d30f89e3ed7abb5337473abb1777018fe2323800e2b1b6a21",
  },
  "./schema": {
    count: 261,
    sha256: "e9e66309a54ef51107e9ab35a03bce99798d91244a3049db4041c7b7bdb664a2",
  },
  "./sqlite/local": {
    count: 680,
    sha256: "9ffda28a91364c5738c14ed1a31060ec991c78371a5fb78fe7bc0158f0bc4ff9",
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
  return stableApiReport(expected) === stableApiReport(actual);
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
