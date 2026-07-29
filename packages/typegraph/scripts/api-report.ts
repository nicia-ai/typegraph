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
 */
const FORGOTTEN_EXPORT_DEBT: Readonly<Record<string, ForgottenExportDebt>> = {
  ".": {
    count: 313,
    sha256: "7672e3857dc7461f1dc5770450e0a3be59cdabd28af93da084ecf803958a4306",
  },
  "./adapters/drizzle/indexes": {
    count: 24,
    sha256: "6c11a8d2c13c886a2d6473f8af99d9c4988c7bbfe97545a6a6f748cdd18bf6d8",
  },
  "./adapters/drizzle/postgres": {
    count: 174,
    sha256: "e95c402a481bcfc7380e6904e312d2be77332284dbbb9feced9a3e21940690b7",
  },
  "./adapters/drizzle/postgres/pglite": {
    count: 178,
    sha256: "1d091ae9dac9fc6f21dc77eee28c204b24525fcf562ab67395d0017dbfbd0b2b",
  },
  "./adapters/drizzle/sqlite": {
    count: 175,
    sha256: "67aafff67e25c9b2bb21624a30226f65957fea08327be485cee45731471fd428",
  },
  "./adapters/drizzle/sqlite/libsql": {
    count: 178,
    sha256: "fc5e8dd3511870bfbe4222ca6f90d41c4f0d3d4fd57f2119dade8f3a8a222836",
  },
  "./adapters/drizzle/sqlite/local": {
    count: 178,
    sha256: "fc5e8dd3511870bfbe4222ca6f90d41c4f0d3d4fd57f2119dade8f3a8a222836",
  },
  "./backend": {
    count: 1,
    sha256: "711e337fd05fa134a31d7d29661a8a2cb1fdd078d56cc1b869251934c0b5416e",
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
    count: 541,
    sha256: "9bf9617b775d0fc1365ecd4631f5a85e81ba4d0979ba4ae0e7c030cc99a12a5e",
  },
  "./indexes": {
    count: 43,
    sha256: "49144a0eeda76d83d8ebe63f533e25796e1b7d46fe521a4adc997fb58cb876bb",
  },
  "./interchange": {
    count: 527,
    sha256: "4fd8c66f582b9484d2993dec353e7467027baea14436281e2e4223b130d5133e",
  },
  "./postgres/pglite": {
    count: 541,
    sha256: "a74c357a33ecf7866b2889a4dcb3f3187028bcbdad97c35e1cdb3839bc894eba",
  },
  "./profiler": {
    count: 529,
    sha256: "b55da3c618a934bcc742920a7539851b7aded4a0a00a36057f1372300c2b68b0",
  },
  "./provenance": {
    count: 535,
    sha256: "d320d4468afd5d90b7bdfe464c32f591a5c85dbccdad059470d635b08e04f1ab",
  },
  "./schema": {
    count: 192,
    sha256: "7c3c29a02e0e15a5b7cfb54cc383084d0c546d7417cf4e90fb5fd92dad202087",
  },
  "./sqlite/local": {
    count: 541,
    sha256: "a74c357a33ecf7866b2889a4dcb3f3187028bcbdad97c35e1cdb3839bc894eba",
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
