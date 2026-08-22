import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  compareExcludedDomains,
  compareMetric,
  type SizeBudgetFile,
  SizeBudgetFileSchema,
} from "../scripts/size-budget/budget";
import {
  listSourceDomains,
  measureDistributionArtifacts,
  measureTarget,
} from "../scripts/size-budget/measure";
import {
  type EntrypointTarget,
  loadEntrypointTargets,
  type ProbeTarget,
  probeTargetsFor,
} from "../scripts/size-budget/targets";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUDGET_FILE_PATH = path.join(PACKAGE_ROOT, "etc/size-budget.json");

function recordedEntrypointOrThrow(
  budget: SizeBudgetFile,
  exportPath: string,
): SizeBudgetFile["entrypoints"][string] {
  const recorded = budget.entrypoints[exportPath];
  if (recorded === undefined) {
    throw new Error(`No recorded budget entry for entrypoint "${exportPath}".`);
  }
  return recorded;
}

function recordedProbeOrThrow(
  budget: SizeBudgetFile,
  probeId: string,
): SizeBudgetFile["probes"][string] {
  const recorded = budget.probes[probeId];
  if (recorded === undefined) {
    throw new Error(`No recorded budget entry for probe "${probeId}".`);
  }
  return recorded;
}

describe("package size budget", () => {
  let recordedBudget: SizeBudgetFile;
  let entrypoints: readonly EntrypointTarget[];
  let probes: readonly ProbeTarget[];
  let domainUniverse: readonly string[];

  beforeAll(async () => {
    const source = await readFile(BUDGET_FILE_PATH, "utf8");
    recordedBudget = SizeBudgetFileSchema.parse(JSON.parse(source));
    entrypoints = await loadEntrypointTargets(PACKAGE_ROOT);
    probes = probeTargetsFor(entrypoints);
    domainUniverse = await listSourceDomains(PACKAGE_ROOT);
  });

  it("keeps every published entrypoint within its recorded byte budget", async () => {
    for (const entrypoint of entrypoints) {
      const recorded = recordedEntrypointOrThrow(
        recordedBudget,
        entrypoint.exportPath,
      );
      const measurement = await measureTarget(entrypoint, PACKAGE_ROOT);
      expect(
        compareMetric(
          entrypoint.exportPath,
          "minified",
          recorded.minified,
          measurement.minified,
        ),
      ).toEqual([]);
      expect(
        compareMetric(
          entrypoint.exportPath,
          "gzip",
          recorded.gzip,
          measurement.gzip,
        ),
      ).toEqual([]);
    }
  });

  it("keeps every single-symbol probe within its recorded byte budget", async () => {
    for (const probe of probes) {
      const recorded = recordedProbeOrThrow(recordedBudget, probe.id);
      const measurement = await measureTarget(probe, PACKAGE_ROOT);
      expect(
        compareMetric(
          probe.id,
          "minified",
          recorded.minified,
          measurement.minified,
        ),
      ).toEqual([]);
      expect(
        compareMetric(probe.id, "gzip", recorded.gzip, measurement.gzip),
      ).toEqual([]);
    }
  });

  it("requires each entrypoint to reach exactly the domains it reached at seed time", async () => {
    for (const entrypoint of entrypoints) {
      const recorded = recordedEntrypointOrThrow(
        recordedBudget,
        entrypoint.exportPath,
      );
      const measurement = await measureTarget(entrypoint, PACKAGE_ROOT);
      expect(
        compareExcludedDomains(
          entrypoint.exportPath,
          recorded.excludedDomains,
          measurement.reachedDomains,
          domainUniverse,
        ),
      ).toEqual([]);
    }
  });

  it("refuses a target that bundles to zero bytes", async () => {
    const [rootEntrypoint] = entrypoints;
    if (rootEntrypoint === undefined) {
      throw new Error("Expected at least one entrypoint target.");
    }
    const zeroByteProbe: ProbeTarget = {
      id: `${rootEntrypoint.exportPath}#notAnExport`,
      kind: "probe",
      exportPath: rootEntrypoint.exportPath,
      sourcePath: rootEntrypoint.sourcePath,
      symbol: "notAnExport",
    };

    await expect(measureTarget(zeroByteProbe, PACKAGE_ROOT)).rejects.toThrow(
      /zero bytes/,
    );
  });

  it("refuses artifact totals when dist has not been built", async () => {
    const emptyDistributionDirectory = await mkdtemp(
      path.join(tmpdir(), "typegraph-size-budget-empty-dist-"),
    );
    try {
      await expect(
        measureDistributionArtifacts(emptyDistributionDirectory),
      ).rejects.toThrow(/pnpm build/);
    } finally {
      await rm(emptyDistributionDirectory, { recursive: true, force: true });
    }
  });
});
