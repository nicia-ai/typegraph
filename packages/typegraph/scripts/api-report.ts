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
    count: 331,
    sha256: "d610b3d605dcb77086cc4c95378261c2dde368fa490cfdcc3ff291ef14ec7a43",
  },
  "./adapters/drizzle/indexes": {
    count: 24,
    sha256: "6c11a8d2c13c886a2d6473f8af99d9c4988c7bbfe97545a6a6f748cdd18bf6d8",
  },
  "./adapters/drizzle/postgres": {
    count: 200,
    sha256: "aa51fd1b20d5c3f7ed7f96957c3d38237977a74eb386349a83ce514737f2cd66",
  },
  "./adapters/drizzle/postgres/pglite": {
    count: 204,
    sha256: "9b51c7ef5328eaeb7148ab20a34a2ea4f429c568ac40da5eea2ba97118789416",
  },
  "./adapters/drizzle/sqlite": {
    count: 201,
    sha256: "ab0011ddf85c8b4556300206bb0e084c62df6c2a11823ae98f75a7dd9d229453",
  },
  "./adapters/drizzle/sqlite/libsql": {
    count: 204,
    sha256: "269fc4d45fd9e2619a2373f6ebe3cdbc56ab8c5925828c64492c31058e5af83b",
  },
  "./adapters/drizzle/sqlite/local": {
    count: 204,
    sha256: "269fc4d45fd9e2619a2373f6ebe3cdbc56ab8c5925828c64492c31058e5af83b",
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
    count: 589,
    sha256: "d2bbc9fdcd47e392a22a6ce3c3254c5fef5f42e48946b77589772e01dd519c01",
  },
  "./indexes": {
    count: 43,
    sha256: "49144a0eeda76d83d8ebe63f533e25796e1b7d46fe521a4adc997fb58cb876bb",
  },
  "./interchange": {
    count: 575,
    sha256: "296b0e2a740dd189df1d563a0092088c7730063c4cc507125e6872e83139b6b9",
  },
  "./postgres/pglite": {
    count: 579,
    sha256: "9a8b19096c9d4597322289f941f7b41319d0aeda9283eb6a83303c1e15e6d9d1",
  },
  "./profiler": {
    count: 577,
    sha256: "d1d47fa5b10b1c641184f9d9d62cc018be135c30f7e32c3e96beef05de074462",
  },
  "./provenance": {
    count: 583,
    sha256: "96d0cf0e5e249284e78166db725cbf53aad8021e75739b5c076c35b2c82103c5",
  },
  "./schema": {
    count: 221,
    sha256: "54f8492aad19b8e6ad432a9628bb3ef9e8bea90d79c9d73890fd9238e5b1041e",
  },
  "./sqlite/local": {
    count: 579,
    sha256: "9a8b19096c9d4597322289f941f7b41319d0aeda9283eb6a83303c1e15e6d9d1",
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
