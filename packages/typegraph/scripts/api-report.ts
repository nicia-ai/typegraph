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
 */
const FORGOTTEN_EXPORT_DEBT: Readonly<Record<string, ForgottenExportDebt>> = {
  ".": {
    count: 352,
    sha256: "a610b66bc7f324f0e03dac8cd259debc38818b29bce80186f1567c9ce87afcfe",
  },
  "./adapters/drizzle/indexes": {
    count: 24,
    sha256: "6c11a8d2c13c886a2d6473f8af99d9c4988c7bbfe97545a6a6f748cdd18bf6d8",
  },
  "./adapters/drizzle/postgres": {
    count: 203,
    sha256: "880ac0f92bbe7da36926c9fe5f4a2b7147345cd22ac7474f3f0bf756d52fc4f1",
  },
  "./adapters/drizzle/postgres/pglite": {
    count: 207,
    sha256: "451d634a38e0391544956ae696dd409a996fa478761dc941ae2528936933bb95",
  },
  "./adapters/drizzle/sqlite": {
    count: 204,
    sha256: "fa02a545f9bcdd4aa7d955a281e543d0fae6cc5ad038ffe42d1536d7e8095d7f",
  },
  "./adapters/drizzle/sqlite/libsql": {
    count: 207,
    sha256: "8925d7e9ea87e5b66ce0945340ee4cfb4b3063b9cf46940fbaae8c9cef1c0951",
  },
  "./adapters/drizzle/sqlite/local": {
    count: 207,
    sha256: "8925d7e9ea87e5b66ce0945340ee4cfb4b3063b9cf46940fbaae8c9cef1c0951",
  },
  "./backend": {
    count: 10,
    sha256: "175a0a4287e06daf2d484c34917bbb09d9c0c8684bc140437e249e8686dfe45d",
  },
  "./core": {
    count: 72,
    sha256: "bf73c4f71677d2b3ec2e36bfd37e9ede5c3f57377fc923f0df2eb1b500cfc84d",
  },
  "./graph-extension": {
    count: 12,
    sha256: "0f36d8f84e9a9d75255b39940c5308ae4df2c3dbe1e0cb2683b00ee8cb974f73",
  },
  "./graph-merge": {
    count: 618,
    sha256: "d8ab78e72bdd81f814343f5089a5721f2ca1226fa16650851ca9ab73824adf1d",
  },
  "./indexes": {
    count: 43,
    sha256: "49144a0eeda76d83d8ebe63f533e25796e1b7d46fe521a4adc997fb58cb876bb",
  },
  "./interchange": {
    count: 604,
    sha256: "ca91504d2b2de3fd93a0276751104608e16d898ab042b3c7872594676e81973f",
  },
  "./postgres/pglite": {
    count: 608,
    sha256: "3cabec91556ea56004cd3c18b24f43d016932e3d8b72468dd2a711ee6620128c",
  },
  "./profiler": {
    count: 606,
    sha256: "d309b02f63b6371d7b149a344c5ea522c9b9031ecba95752ba514850eca646a8",
  },
  "./provenance": {
    count: 612,
    sha256: "f94226600c5c8a0509b843360f5f446123157db2808d4cc8d972dd0444c2ae42",
  },
  "./schema": {
    count: 224,
    sha256: "a1de7419e9b7cba15f310444ed2addc60d5aa17ce81ca35b15bdce8cbddcd870",
  },
  "./sqlite/local": {
    count: 608,
    sha256: "3cabec91556ea56004cd3c18b24f43d016932e3d8b72468dd2a711ee6620128c",
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
