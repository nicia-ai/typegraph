import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BUDGET_HEADROOM,
  budgetCeiling,
  compareInventory,
  compareMetric,
  type SizeBudgetFile,
  SizeBudgetFileSchema,
  type ViolationKind,
} from "../scripts/size-budget/budget";
import { sourceDomain } from "../scripts/size-budget/measure";
import {
  loadEntrypointTargets,
  PROBE_SYMBOLS,
  probeTargetsFor,
  sourcePathForExport,
} from "../scripts/size-budget/targets";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUDGET_FILE_PATH = path.join(PACKAGE_ROOT, "etc/size-budget.json");

async function loadRecordedBudget(): Promise<SizeBudgetFile> {
  const source = await readFile(BUDGET_FILE_PATH, "utf8");
  return SizeBudgetFileSchema.parse(JSON.parse(source));
}

describe("size budget inventory", () => {
  it("records a budget for every published entrypoint and nothing else", async () => {
    const recordedBudget = await loadRecordedBudget();
    const entrypoints = await loadEntrypointTargets(PACKAGE_ROOT);

    const violations = compareInventory(
      entrypoints.map((entrypoint) => entrypoint.exportPath),
      Object.keys(recordedBudget.entrypoints),
    );

    expect(violations).toEqual([]);
  });

  it("resolves every published entrypoint to an existing source file", async () => {
    const entrypoints = await loadEntrypointTargets(PACKAGE_ROOT);

    for (const entrypoint of entrypoints) {
      const absoluteSourcePath = path.join(PACKAGE_ROOT, entrypoint.sourcePath);
      await expect(
        access(absoluteSourcePath),
        `${entrypoint.exportPath} resolves to a source file at ${entrypoint.sourcePath}`,
      ).resolves.toBeUndefined();
    }
  });

  it(
    "probes a symbol that exists as a runtime value in its entrypoint",
    // Dynamically imports one module per probe, each transformed on the fly
    // by vite-node. Under file-parallel load this is the same class of
    // latency the PGLITE_GLOBS project comment in vitest.config.ts documents
    // for WASM Postgres boot: real work, not a correctness failure, that the
    // default 5s "main" budget cannot always absorb. Same 60s budget as the
    // pglite/graph-merge projects, applied per-test since this file's other
    // tests are fast and stay on the default budget.
    { timeout: 60_000 },
    async () => {
      const entrypoints = await loadEntrypointTargets(PACKAGE_ROOT);
      const probes = probeTargetsFor(entrypoints);

      for (const probe of probes) {
        const absoluteSourcePath = path.join(PACKAGE_ROOT, probe.sourcePath);
        const module_ = (await import(
          pathToFileURL(absoluteSourcePath).href
        )) as Record<string, unknown>;
        expect(
          module_[probe.symbol],
          `${probe.id} resolves "${probe.symbol}" to a runtime value`,
        ).not.toBeUndefined();
      }
    },
  );

  it("classifies esbuild metafile input paths into src/ domains", () => {
    expect(sourceDomain("src/index.ts")).toBe("(root)");
    expect(sourceDomain("src/core/index.ts")).toBe("core");
    expect(sourceDomain("src/core/node.ts")).toBe("core");
    expect(sourceDomain("<stdin>")).toBeUndefined();
    expect(sourceDomain("node_modules/zod/index.js")).toBeUndefined();
  });

  it("maps a dist import path to its source file", () => {
    expect(sourcePathForExport("./dist/index.js")).toBe("src/index.ts");
    expect(sourcePathForExport("./dist/backend/sqlite/local-store.js")).toBe(
      "src/backend/sqlite/local-store.ts",
    );
  });

  it("names exactly the reference probe symbols", () => {
    expect(PROBE_SYMBOLS.map((probe) => probe.exportPath)).toEqual([
      ".",
      "./core",
      "./schema",
      "./indexes",
      "./interchange",
      "./graph-merge",
      "./adapters/drizzle/sqlite",
    ]);
  });

  it("enumerates every violation kind compareMetric and compareInventory can produce", () => {
    const kinds: readonly ViolationKind[] = [
      "over-budget",
      "domain-mismatch",
      "missing-entry",
      "stale-entry",
    ];
    expect(kinds).toHaveLength(4);
  });

  it("pins the headroom policy", () => {
    expect(BUDGET_HEADROOM).toBe(1.05);
    expect(budgetCeiling(1000)).toBe(1050);
  });

  it("flags a metric above the ceiling only", () => {
    expect(compareMetric("target", "minified", 1000, 1050)).toEqual([]);
    expect(
      compareMetric("target", "minified", 1000, 1051).map(
        (violation) => violation.kind,
      ),
    ).toEqual(["over-budget"]);
    expect(compareMetric("target", "minified", 1000, 1)).toEqual([]);
  });

  it("names both a missing and a stale budget entry", () => {
    const violations = compareInventory(
      ["./expected-only", "./shared"],
      ["./shared", "./stale-only"],
    );

    expect(violations).toEqual([
      expect.objectContaining({
        targetId: "./expected-only",
        kind: "missing-entry",
      }),
      expect.objectContaining({
        targetId: "./stale-only",
        kind: "stale-entry",
      }),
    ]);
  });
});
