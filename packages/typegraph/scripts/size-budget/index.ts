import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type BudgetViolation,
  compareExcludedDomains,
  compareInventory,
  compareMetric,
  type SizeBudgetFile,
  SizeBudgetFileSchema,
} from "./budget";
import {
  listSourceDomains,
  measureDistributionArtifacts,
  measureTarget,
  type SizeMeasurement,
} from "./measure";
import {
  type EntrypointTarget,
  loadEntrypointTargets,
  type ProbeTarget,
  probeTargetsFor,
  type SizeTarget,
} from "./targets";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const BUDGET_FILE_PATH = path.join(PACKAGE_ROOT, "etc/size-budget.json");
const DISTRIBUTION_DIRECTORY = path.join(PACKAGE_ROOT, "dist");

type MeasuredTarget<T extends SizeTarget> = Readonly<{
  target: T;
  measurement: SizeMeasurement;
}>;

/**
 * The single place both `update()` and `check()` gather measurements from —
 * neither re-implements the loop over targets that calls `measureTarget`.
 */
async function measureAllTargets<T extends SizeTarget>(
  targets: readonly T[],
): Promise<readonly MeasuredTarget<T>[]> {
  return Promise.all(
    targets.map(async (target): Promise<MeasuredTarget<T>> => {
      const measurement = await measureTarget(target, PACKAGE_ROOT);
      return { target, measurement };
    }),
  );
}

async function loadRecordedBudget(): Promise<SizeBudgetFile> {
  const source = await readFile(BUDGET_FILE_PATH, "utf8");
  return SizeBudgetFileSchema.parse(JSON.parse(source));
}

async function writeRecordedBudget(budget: SizeBudgetFile): Promise<void> {
  await writeFile(
    BUDGET_FILE_PATH,
    `${JSON.stringify(budget, undefined, 2)}\n`,
  );
}

async function update(): Promise<void> {
  const entrypoints = await loadEntrypointTargets(PACKAGE_ROOT);
  const probes = probeTargetsFor(entrypoints);
  const domainUniverse = await listSourceDomains(PACKAGE_ROOT);

  const [measuredEntrypoints, measuredProbes, artifacts] = await Promise.all([
    measureAllTargets(entrypoints),
    measureAllTargets(probes),
    measureDistributionArtifacts(DISTRIBUTION_DIRECTORY),
  ]);

  const budget: SizeBudgetFile = {
    entrypoints: Object.fromEntries(
      measuredEntrypoints.map(({ target, measurement }) => {
        const excludedDomains = domainUniverse.filter(
          (domain) => !measurement.reachedDomains.includes(domain),
        );
        return [
          target.exportPath,
          {
            minified: measurement.minified,
            gzip: measurement.gzip,
            excludedDomains,
          },
        ];
      }),
    ),
    probes: Object.fromEntries(
      measuredProbes.map(({ target, measurement }) => [
        target.id,
        { minified: measurement.minified, gzip: measurement.gzip },
      ]),
    ),
    artifacts,
  };

  await writeRecordedBudget(budget);
  console.log(
    `Wrote size budget: ${entrypoints.length} entrypoints, ${probes.length} probes, dist artifacts ${JSON.stringify(artifacts)}.`,
  );
}

function checkEntrypointViolations(
  measured: MeasuredTarget<EntrypointTarget>,
  recordedBudget: SizeBudgetFile,
  domainUniverse: readonly string[],
): readonly BudgetViolation[] {
  const { target, measurement } = measured;
  const recordedEntry = recordedBudget.entrypoints[target.exportPath];
  if (recordedEntry === undefined) {
    return [];
  }
  return [
    ...compareMetric(
      target.exportPath,
      "minified",
      recordedEntry.minified,
      measurement.minified,
    ),
    ...compareMetric(
      target.exportPath,
      "gzip",
      recordedEntry.gzip,
      measurement.gzip,
    ),
    ...compareExcludedDomains(
      target.exportPath,
      recordedEntry.excludedDomains,
      measurement.reachedDomains,
      domainUniverse,
    ),
  ];
}

function checkProbeViolations(
  measured: MeasuredTarget<ProbeTarget>,
  recordedBudget: SizeBudgetFile,
): readonly BudgetViolation[] {
  const { target, measurement } = measured;
  const recordedEntry = recordedBudget.probes[target.id];
  if (recordedEntry === undefined) {
    return [];
  }
  return [
    ...compareMetric(
      target.id,
      "minified",
      recordedEntry.minified,
      measurement.minified,
    ),
    ...compareMetric(target.id, "gzip", recordedEntry.gzip, measurement.gzip),
  ];
}

async function check(): Promise<void> {
  const recordedBudget = await loadRecordedBudget();
  const entrypoints = await loadEntrypointTargets(PACKAGE_ROOT);
  const probes = probeTargetsFor(entrypoints);
  const domainUniverse = await listSourceDomains(PACKAGE_ROOT);

  const [measuredEntrypoints, measuredProbes, artifacts] = await Promise.all([
    measureAllTargets(entrypoints),
    measureAllTargets(probes),
    measureDistributionArtifacts(DISTRIBUTION_DIRECTORY),
  ]);

  const violations: BudgetViolation[] = [
    ...compareInventory(
      entrypoints.map((entrypoint) => entrypoint.exportPath),
      Object.keys(recordedBudget.entrypoints),
    ),
    ...compareInventory(
      probes.map((probe) => probe.id),
      Object.keys(recordedBudget.probes),
    ),
    ...measuredEntrypoints.flatMap((measured) =>
      checkEntrypointViolations(measured, recordedBudget, domainUniverse),
    ),
    ...measuredProbes.flatMap((measured) =>
      checkProbeViolations(measured, recordedBudget),
    ),
    ...compareMetric(
      "dist",
      "esmBytes",
      recordedBudget.artifacts.esmBytes,
      artifacts.esmBytes,
    ),
    ...compareMetric(
      "dist",
      "cjsBytes",
      recordedBudget.artifacts.cjsBytes,
      artifacts.cjsBytes,
    ),
    ...compareMetric(
      "dist",
      "declarationBytes",
      recordedBudget.artifacts.declarationBytes,
      artifacts.declarationBytes,
    ),
  ];

  for (const violation of violations) {
    console.error(
      `[size-budget] ${violation.targetId} ${violation.metric} (${violation.kind}): ${violation.detail}`,
    );
  }

  if (violations.length > 0) {
    console.error(
      `Size budget check failed with ${violations.length} violation(s).`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Size budget OK: ${entrypoints.length} entrypoints, ${probes.length} probes, dist artifacts within window.`,
  );
}

async function run(): Promise<void> {
  if (process.argv.includes("--update")) {
    await update();
  } else {
    await check();
  }
}

await run();
