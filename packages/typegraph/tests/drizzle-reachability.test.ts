/**
 * I2/I3 baseline ratchet — records today's measured Drizzle-reachability
 * numbers (source grain and dist grain) as executable data. Nothing here is
 * fixed yet: every `RECORDED_*` constant below is a fact about `29d63ec`,
 * with the command that produced it named beside it, per
 * `design-ws8-port-isolation.md` §2.1. A later batch (B4) flips the portable
 * rows to clean at both grains and both formats; this batch only proves the
 * scanner reproduces what is true today.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ADAPTER_ENTRYPOINTS,
  classifyEntrypoints,
  collectModuleEdges,
  countComputedSpecifierSites,
  distArtifactsPresent as distributionArtifactsPresent,
  type EntrypointClassification,
  PORTABILITY_EXEMPTIONS,
  type ReachabilityVerdict,
  resolveGrain,
  resolveSeveranceStage,
  resolveSeveredModules,
  scanDistReachability as scanDistributionReachability,
  scanSourceReachability,
  SIMULATED_SEVERANCE_STAGES,
  sourceRootForEntrypoint,
} from "../scripts/drizzle-reachability-scan";

/**
 * Recorded at `29d63ec` by `node --import tsx
 * scripts/drizzle-reachability-scan.ts --grain=source` — every published
 * entrypoint, classified. Ten portable, eight adapter (the six true
 * `./adapters/drizzle/*` entrypoints plus the two "batteries included"
 * entrypoints that still construct their connection eagerly today).
 */
const RECORDED_CLASSIFICATIONS: Readonly<
  Record<string, EntrypointClassification>
> = {
  ".": "portable",
  "./backend": "portable",
  "./core": "portable",
  "./interchange": "portable",
  "./profiler": "portable",
  "./schema": "portable",
  "./indexes": "portable",
  "./graph-extension": "portable",
  "./graph-merge": "portable",
  "./provenance": "portable",
  "./sqlite/local": "adapter-static",
  "./postgres/pglite": "adapter-static",
  "./adapters/drizzle/sqlite": "adapter-static",
  "./adapters/drizzle/postgres": "adapter-static",
  "./adapters/drizzle/postgres/pglite": "adapter-static",
  "./adapters/drizzle/sqlite/local": "adapter-static",
  "./adapters/drizzle/sqlite/libsql": "adapter-static",
  "./adapters/drizzle/indexes": "adapter-static",
};

const RECORDED_ENTRYPOINTS = Object.keys(RECORDED_CLASSIFICATIONS);
const RECORDED_TRUE_ADAPTER_ENTRYPOINTS = RECORDED_ENTRYPOINTS.filter(
  (entrypoint) => entrypoint.startsWith("./adapters/drizzle/"),
);
const RECORDED_NON_ADAPTER_ENTRYPOINTS = RECORDED_ENTRYPOINTS.filter(
  (entrypoint) => !entrypoint.startsWith("./adapters/drizzle/"),
);
const RECORDED_PORTABLE_ENTRYPOINTS = RECORDED_ENTRYPOINTS.filter(
  (entrypoint) => RECORDED_CLASSIFICATIONS[entrypoint] === "portable",
);

/**
 * Recorded at `29d63ec` by `--grain=source` — every published entrypoint
 * reaches Drizzle today, at both walk modes, because no source file has been
 * severed yet.
 */
const RECORDED_SOURCE_VERDICTS: Readonly<Record<string, ReachabilityVerdict>> =
  Object.fromEntries(
    RECORDED_ENTRYPOINTS.map((entrypoint) => [entrypoint, "dirty"]),
  );

/**
 * Recorded at `29d63ec` by `--grain=source --stage=<name>`, filtered to the
 * ten portable entrypoints at `load` mode — §3.1's three severance routes,
 * simulated one group at a time.
 */
const RECORDED_STAGE_DIRTY_COUNTS: Readonly<Record<string, number>> = {
  baseline: 10,
  "axis+migrate": 5,
  "axis+migrate+removals": 0,
};

/** The five portable entrypoints still dirty once R-axis and R-migrate are severed. */
const RECORDED_AXIS_MIGRATE_DIRTY_ENTRYPOINTS = [
  ".",
  "./interchange",
  "./profiler",
  "./graph-merge",
  "./provenance",
].toSorted();

/** One witness chain per severance route, as `--grain=source --stage=<name>` prints it. */
const RECORDED_ROUTE_CHAINS = {
  "R-axis": {
    stage: "baseline",
    entrypoint: "./core",
    mode: "load",
    chain: [
      { from: "src/core/index.ts", to: "src/core/node.ts", kind: "static" },
      {
        from: "src/core/node.ts",
        to: "src/store/claims/axis.ts",
        kind: "static",
      },
      { from: "src/store/claims/axis.ts", to: "drizzle-orm", kind: "static" },
    ],
  },
  "R-migrate": {
    stage: "baseline",
    entrypoint: "./backend",
    mode: "load",
    chain: [
      {
        from: "src/backend/index.ts",
        to: "src/backend/migrate-recorded-time.ts",
        kind: "static",
      },
      {
        from: "src/backend/migrate-recorded-time.ts",
        to: "src/backend/drizzle/ddl.ts",
        kind: "static",
      },
      { from: "src/backend/drizzle/ddl.ts", to: "drizzle-orm", kind: "static" },
    ],
  },
  "R-removals": {
    stage: "axis+migrate",
    entrypoint: ".",
    mode: "load",
    chain: [
      { from: "src/index.ts", to: "src/store/index.ts", kind: "static" },
      {
        from: "src/store/index.ts",
        to: "src/store/materialize-removals.ts",
        kind: "static",
      },
      {
        from: "src/store/materialize-removals.ts",
        to: "src/backend/drizzle/operations/edge-claims.ts",
        kind: "static",
      },
      {
        from: "src/backend/drizzle/operations/edge-claims.ts",
        to: "drizzle-orm",
        kind: "static",
      },
    ],
  },
} as const;

/**
 * Recorded at `29d63ec` by `pnpm build && --grain=dist`, `load` mode — 9 of
 * 12 non-adapter entrypoints resolve a Drizzle specifier at module load, in
 * both artifact formats (they agree entrywise today; no entrypoint defers
 * Drizzle behind a dynamic import yet).
 */
const RECORDED_DIST_LOAD_VERDICTS: Readonly<
  Record<string, ReachabilityVerdict>
> = {
  ".": "dirty",
  "./backend": "dirty",
  "./core": "dirty",
  "./interchange": "dirty",
  "./profiler": "clean",
  "./schema": "dirty",
  "./indexes": "clean",
  "./graph-extension": "clean",
  "./graph-merge": "dirty",
  "./provenance": "dirty",
  "./sqlite/local": "dirty",
  "./postgres/pglite": "dirty",
  "./adapters/drizzle/sqlite": "dirty",
  "./adapters/drizzle/postgres": "dirty",
  "./adapters/drizzle/postgres/pglite": "dirty",
  "./adapters/drizzle/sqlite/local": "dirty",
  "./adapters/drizzle/sqlite/libsql": "dirty",
  "./adapters/drizzle/indexes": "dirty",
};

function dirtyPortableEntrypointsAtStage(
  stage: (typeof SIMULATED_SEVERANCE_STAGES)[number],
): readonly string[] {
  return scanSourceReachability({ severedModules: stage.severedModules })
    .filter(
      (finding) =>
        finding.mode === "load" &&
        RECORDED_PORTABLE_ENTRYPOINTS.includes(finding.entrypoint) &&
        finding.verdict === "dirty",
    )
    .map((finding) => finding.entrypoint);
}

describe("drizzle reachability — source grain", () => {
  it("classifies every published entrypoint and nothing else", () => {
    const classification = classifyEntrypoints();
    expect(classification).toEqual(RECORDED_CLASSIFICATIONS);

    // Every key in ADAPTER_ENTRYPOINTS must itself be a published entrypoint;
    // classifyEntrypoints() alone cannot catch a phantom key, since it only
    // ever iterates the REAL export keys.
    const publishedEntrypoints = new Set(Object.keys(classification));
    for (const entrypoint of Object.keys(ADAPTER_ENTRYPOINTS)) {
      expect(
        publishedEntrypoints.has(entrypoint),
        `ADAPTER_ENTRYPOINTS names ${entrypoint}, which is not a published entrypoint`,
      ).toBe(true);
    }
  });

  it("extracts all four static edge forms and the dynamic form", () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "drizzle-reachability-fixture-"),
    );
    try {
      const fixturePath = path.join(temporaryDirectory, "fixture.ts");
      fs.writeFileSync(
        fixturePath,
        [
          'import { a } from "./a";',
          'export { b } from "./b";',
          'export * from "./c";',
          'const d = require("./d");',
          'async function loadE() { return import("./e"); }',
          "void d;",
          "void loadE;",
        ].join("\n"),
      );

      const edges = collectModuleEdges(fixturePath);
      expect(edges).toEqual([
        { specifier: "./a", kind: "static" },
        { specifier: "./b", kind: "static" },
        { specifier: "./c", kind: "static" },
        { specifier: "./d", kind: "static" },
        { specifier: "./e", kind: "dynamic" },
      ]);
      expect(countComputedSpecifierSites(fixturePath)).toBe(0);
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("derives source roots from the tsup entry map", () => {
    expect(sourceRootForEntrypoint(".")).toBe("src/index.ts");
    expect(sourceRootForEntrypoint("./core")).toBe("src/core/index.ts");
    expect(sourceRootForEntrypoint("./sqlite/local")).toBe(
      "src/backend/sqlite/local-store.ts",
    );
    expect(sourceRootForEntrypoint("./postgres/pglite")).toBe(
      "src/backend/postgres/pglite-store.ts",
    );
  });

  it("records today's source verdicts for all 18 entrypoints (12 of 12 non-adapter dirty)", () => {
    expect(RECORDED_TRUE_ADAPTER_ENTRYPOINTS.length).toBe(6);
    expect(RECORDED_NON_ADAPTER_ENTRYPOINTS.length).toBe(12);
    expect(
      RECORDED_NON_ADAPTER_ENTRYPOINTS.every(
        (entrypoint) => RECORDED_SOURCE_VERDICTS[entrypoint] === "dirty",
      ),
    ).toBe(true);

    const findings = scanSourceReachability();
    expect(findings.length).toBe(RECORDED_ENTRYPOINTS.length * 2);

    const recordedEntrypoints = new Set(RECORDED_ENTRYPOINTS);
    for (const finding of findings) {
      expect(
        recordedEntrypoints.has(finding.entrypoint),
        `scanner reported an unrecorded entrypoint: ${finding.entrypoint}`,
      ).toBe(true);
    }

    for (const entrypoint of RECORDED_ENTRYPOINTS) {
      for (const mode of ["load", "deferred"] as const) {
        const finding = findings.find(
          (candidate) =>
            candidate.entrypoint === entrypoint && candidate.mode === mode,
        );
        expect(finding?.verdict, `${entrypoint} (${mode})`).toBe(
          RECORDED_SOURCE_VERDICTS[entrypoint],
        );
      }
    }
  });

  it.each(Object.entries(RECORDED_ROUTE_CHAINS))(
    "names the shortest chain for severance route %s",
    (_route, witness) => {
      const stage = resolveSeveranceStage(witness.stage);
      const findings = scanSourceReachability({
        severedModules: stage.severedModules,
      });
      const finding = findings.find(
        (candidate) =>
          candidate.entrypoint === witness.entrypoint &&
          candidate.mode === witness.mode,
      );
      expect(finding?.chain).toEqual(witness.chain);
    },
  );

  it("reproduces the staged-severance projection 10/10 -> 5/10 -> 0/10", () => {
    expect(RECORDED_PORTABLE_ENTRYPOINTS.length).toBe(10);

    for (const stage of SIMULATED_SEVERANCE_STAGES) {
      const dirtyCount = dirtyPortableEntrypointsAtStage(stage).length;
      expect({ [stage.name]: dirtyCount }).toEqual({
        [stage.name]: RECORDED_STAGE_DIRTY_COUNTS[stage.name],
      });
    }
  });

  it("names the five entrypoints still dirty at stage axis+migrate", () => {
    const stage = resolveSeveranceStage("axis+migrate");
    const dirty = dirtyPortableEntrypointsAtStage(stage).toSorted();
    expect(dirty).toEqual(RECORDED_AXIS_MIGRATE_DIRTY_ENTRYPOINTS);
  });

  it("throws naming the unknown stage and every valid stage name", () => {
    expect(() => resolveSeveranceStage("axis+migrat")).toThrow(
      'Unknown severance stage "axis+migrat". Valid stage names: baseline, axis+migrate, axis+migrate+removals.',
    );
  });

  it("throws naming the unknown grain and every valid grain, rather than silently scanning source", () => {
    expect(() => resolveGrain("dsit")).toThrow(
      'Unknown grain "dsit". Valid grains: source, dist.',
    );
    expect(resolveGrain("source")).toBe("source");
    expect(resolveGrain("dist")).toBe("dist");
  });

  it("throws on a valueless --stage, whether bare or space-separated, rather than silently reporting the baseline", () => {
    expect(() => resolveSeveredModules(["--stage"])).toThrow(
      "--stage requires a value in the form --stage=<name>. Valid stage names: baseline, axis+migrate, axis+migrate+removals.",
    );
    expect(() => resolveSeveredModules(["--stage", "axis+migrate"])).toThrow(
      "--stage requires a value in the form --stage=<name>. Valid stage names: baseline, axis+migrate, axis+migrate+removals.",
    );
  });

  it("refuses --stage and --sever together instead of silently discarding one", () => {
    expect(() =>
      resolveSeveredModules(["--stage=axis+migrate", "--sever=src/foo.ts"]),
    ).toThrow(
      "--stage and --sever cannot both be given; pass --stage=<name> to select a SIMULATED_SEVERANCE_STAGES entry, or --sever=<comma-separated modules> for an explicit list, but not both.",
    );
  });

  it("resolves --stage and --sever independently when given alone", () => {
    expect(resolveSeveredModules([])).toEqual([]);
    expect(resolveSeveredModules(["--stage=axis+migrate"])).toEqual(
      resolveSeveranceStage("axis+migrate").severedModules,
    );
    expect(resolveSeveredModules(["--sever=src/a.ts,src/b.ts"])).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  /**
   * I2's exemption ledger check (§ design's I2 row: "the list ships empty,
   * and the both-directions assertion makes an empty list assertable rather
   * than merely absent"). Lives here, in the UNGATED source-grain describe,
   * not inside the dist-grain `describe.skipIf` below: it consults only
   * {@link scanSourceReachability}, so it has no `pnpm build` dependency and
   * must run in every `pnpm test` invocation and in CI's coverage shard
   * (`.github/workflows/ci.yml`'s `test-coverage` job never runs `pnpm
   * build`), not only when `dist/` happens to be present locally.
   *
   * Two independent containments make evaluating one corner of the
   * grain/mode square equivalent to checking the union of all four:
   *
   * - **Grain.** Checked at source grain rather than dist grain because I3's
   *   containment property (`design-ws8-port-isolation.md` §I3: "the
   *   measured dist-dirty set is entrywise a subset of the source-dirty
   *   set") makes the two equivalent for this purpose: dist just walks the
   *   tree-shaken remainder of the same module graph, so an entrypoint dirty
   *   at dist is always dirty at source too. Evaluating against source
   *   grain alone therefore covers the direction dist-only checking missed,
   *   where an entrypoint (`./profiler`, `./indexes`, `./graph-extension`
   *   today) is dirty at source but clean at dist.
   * - **Mode.** Checked at `deferred` mode (every edge) rather than `load`
   *   mode (static edges only) for the identical reason one level down:
   *   `walk()` drops every dynamic edge in `load` mode
   *   (`scripts/drizzle-reachability-scan.ts`'s `if (mode === "load" &&
   *   edge.kind === "dynamic") continue;`), so an entrypoint dirty at `load`
   *   is always dirty at `deferred` too — `deferred` is the union across
   *   modes, not merely "the other mode". Filtering on `load` here would
   *   reject an exemption for a portable entrypoint that reaches Drizzle
   *   only through a relative `await import()` (the sanctioned in-tree
   *   pattern after design §4.4b, and the evasion shape design I2/F-5.1
   *   exists to catch) as "not dirty", even though it is dirty at
   *   `deferred`.
   */
  it("an exemption names an entrypoint that is actually dirty", () => {
    expect(PORTABILITY_EXEMPTIONS).toEqual([]);

    const sourceFindings = scanSourceReachability().filter(
      (finding) => finding.mode === "deferred",
    );
    for (const exemption of PORTABILITY_EXEMPTIONS) {
      const stillDirty = sourceFindings.some(
        (finding) =>
          finding.entrypoint === exemption.entrypoint &&
          finding.verdict === "dirty",
      );
      expect(
        stillDirty,
        `exemption for ${exemption.entrypoint} names an entrypoint that is not dirty at source grain (either mode)`,
      ).toBe(true);
    }
  });
});

/**
 * The decision the dist-grain `describe.skipIf` below is built from — named
 * so it is testable directly, without depending on vitest's collection-time
 * evaluation of `process.env` (a mutated env var inside an `it()` cannot
 * retroactively un-skip a sibling `describe` block, since collection
 * happens before any test body runs). `TYPEGRAPH_REQUIRE_DIST_GRAIN=1`
 * refuses to skip even when the artifacts are absent, so a lane that forgot
 * to `pnpm build` first fails loudly instead of silently reporting green.
 */
function shouldSkipDistributionGrain(
  distributionPresent: boolean,
  requireDistributionGrainEnv: string | undefined,
): boolean {
  return !distributionPresent && requireDistributionGrainEnv !== "1";
}

describe("drizzle reachability — dist grain", () => {
  describe.skipIf(
    shouldSkipDistributionGrain(
      distributionArtifactsPresent(),
      process.env["TYPEGRAPH_REQUIRE_DIST_GRAIN"],
    ),
  )("shipped artifacts", () => {
    it("covers both artifact formats of all 18 entrypoints", () => {
      const findings = scanDistributionReachability();
      expect(findings.length).toBe(RECORDED_ENTRYPOINTS.length * 2 * 2);

      for (const entrypoint of RECORDED_ENTRYPOINTS) {
        for (const format of ["import", "require"] as const) {
          for (const mode of ["load", "deferred"] as const) {
            const match = findings.find(
              (finding) =>
                finding.entrypoint === entrypoint &&
                finding.format === format &&
                finding.mode === mode,
            );
            expect(match, `${entrypoint} [${format}] (${mode})`).toBeDefined();
          }
        }

        // Each format resolves its OWN root — never both derived from
        // `.import` (which would silently re-scan the ESM artifact under the
        // "require" label instead of the real `.cjs`).
        const importFinding = findings.find(
          (finding) =>
            finding.entrypoint === entrypoint &&
            finding.format === "import" &&
            finding.mode === "load",
        );
        const requireFinding = findings.find(
          (finding) =>
            finding.entrypoint === entrypoint &&
            finding.format === "require" &&
            finding.mode === "load",
        );
        expect(requireFinding?.root, `${entrypoint} require root`).not.toBe(
          importFinding?.root,
        );
        expect(requireFinding?.root, `${entrypoint} require root`).toMatch(
          /\.cjs$/,
        );
        expect(importFinding?.root, `${entrypoint} import root`).toMatch(
          /\.js$/,
        );
      }

      // The two entrypoints a `dist/**/index.js` glob would miss entirely
      // (their artifact basenames are `local-store.*` / `pglite-store.*`,
      // not `index.*`).
      for (const entrypoint of ["./sqlite/local", "./postgres/pglite"]) {
        for (const format of ["import", "require"] as const) {
          const match = findings.find(
            (finding) =>
              finding.entrypoint === entrypoint && finding.format === format,
          );
          expect(match, `${entrypoint} [${format}]`).toBeDefined();
        }
      }
    });

    it("records today's dist load verdicts in both formats (9 of 12 non-adapter dirty at load; clean: ./profiler, ./indexes, ./graph-extension)", () => {
      const nonAdapterEntrypoints = Object.keys(
        RECORDED_DIST_LOAD_VERDICTS,
      ).filter((entrypoint) => !entrypoint.startsWith("./adapters/drizzle/"));
      expect(nonAdapterEntrypoints.length).toBe(12);
      const dirtyNonAdapter = nonAdapterEntrypoints.filter(
        (entrypoint) => RECORDED_DIST_LOAD_VERDICTS[entrypoint] === "dirty",
      );
      expect(dirtyNonAdapter.length).toBe(9);
      const cleanNonAdapter = nonAdapterEntrypoints
        .filter(
          (entrypoint) => RECORDED_DIST_LOAD_VERDICTS[entrypoint] === "clean",
        )
        .toSorted();
      expect(cleanNonAdapter).toEqual([
        "./graph-extension",
        "./indexes",
        "./profiler",
      ]);

      const findings = scanDistributionReachability().filter(
        (finding) => finding.mode === "load",
      );
      for (const [entrypoint, verdict] of Object.entries(
        RECORDED_DIST_LOAD_VERDICTS,
      )) {
        for (const format of ["import", "require"] as const) {
          const match = findings.find(
            (finding) =>
              finding.entrypoint === entrypoint && finding.format === format,
          );
          expect(match?.verdict, `${entrypoint} [${format}]`).toBe(verdict);
        }
      }
    });
  });

  it("refuses to skip the dist grain when TYPEGRAPH_REQUIRE_DIST_GRAIN=1", () => {
    expect(shouldSkipDistributionGrain(false, "1")).toBe(false);
    expect(shouldSkipDistributionGrain(true, "1")).toBe(false);
    expect(shouldSkipDistributionGrain(false, undefined)).toBe(true);
    expect(shouldSkipDistributionGrain(true, undefined)).toBe(false);
  });
});
