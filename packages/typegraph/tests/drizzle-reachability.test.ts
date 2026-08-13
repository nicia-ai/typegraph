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
 * Recorded at HEAD by `--grain=source` (`20 / 36 dirty`) — an explicit,
 * per-entrypoint table with a reason for each row, replacing B1's "every
 * entrypoint is dirty" derivation now that this batch has severed R-axis
 * (`src/store/claims/axis.ts`) and R-removals
 * (`src/store/materialize-removals.ts`). Two portable entrypoints remain
 * dirty — R-migrate's residue, B3's route — and every adapter entrypoint
 * stays dirty by design (§3.1, §4.6).
 */
const RECORDED_SOURCE_VERDICTS: Readonly<Record<string, ReachabilityVerdict>> =
  {
    // R-migrate residue (`src/backend/migrate-recorded-time.ts` ->
    // `src/backend/drizzle/ddl.ts`), B3's route — not severed by this batch.
    ".": "dirty",
    "./backend": "dirty",
    // R-axis severed in this batch (`src/store/claims/axis.ts` no longer
    // imports `drizzle-orm`).
    "./core": "clean",
    // R-removals severed in this batch (`src/store/materialize-removals.ts`
    // no longer imports the adapter-owned builders).
    "./interchange": "clean",
    "./profiler": "clean",
    "./schema": "clean",
    "./indexes": "clean",
    "./graph-extension": "clean",
    "./graph-merge": "clean",
    "./provenance": "clean",
    // Adapter entrypoints: expected to reach Drizzle (ADAPTER_ENTRYPOINTS).
    "./sqlite/local": "dirty",
    "./postgres/pglite": "dirty",
    "./adapters/drizzle/sqlite": "dirty",
    "./adapters/drizzle/postgres": "dirty",
    "./adapters/drizzle/postgres/pglite": "dirty",
    "./adapters/drizzle/sqlite/local": "dirty",
    "./adapters/drizzle/sqlite/libsql": "dirty",
    "./adapters/drizzle/indexes": "dirty",
  };

/** The four non-adapter entrypoints still dirty at source grain (R-migrate's residue plus the two "batteries included" adapters). */
const RECORDED_DIRTY_NON_ADAPTER_ENTRYPOINTS = [
  ".",
  "./backend",
  "./sqlite/local",
  "./postgres/pglite",
].toSorted();

/**
 * Recorded at HEAD by `--grain=source --stage=<name>`, filtered to the ten
 * portable entrypoints at `load` mode. R-axis and R-removals are now REALLY
 * severed (not simulated), so simulating them again at `axis+migrate` /
 * `axis+migrate+removals` is a no-op on top of the real severance — what
 * those stages now additionally simulate is R-migrate
 * (`migrate-recorded-time.ts` + `migrate-vectors.ts`), which is what drives
 * both down to 0/10. `baseline` (no simulated severance at all) is where
 * R-migrate's real, unsevered residue shows up.
 */
const RECORDED_STAGE_DIRTY_COUNTS: Readonly<Record<string, number>> = {
  baseline: 2,
  "axis+migrate": 0,
  "axis+migrate+removals": 0,
};

/**
 * The two portable entrypoints still dirty at stage `baseline` — R-migrate's
 * residue, B3's route, not severed by this batch.
 *
 * This replaces B1's `RECORDED_AXIS_MIGRATE_DIRTY_ENTRYPOINTS`. That constant
 * named the five entrypoints still dirty after SIMULATING R-axis and
 * R-migrate's severance; now that R-axis is REALLY severed, its post-B2 value
 * would be `[]`, and an empty-list assertion at a stage where every one of
 * this batch's routes is already severed for real cannot fail for the right
 * reason (mutating the scanner's severance logic for a stage that changes
 * nothing observable does not move an empty array). The live residue this
 * batch leaves behind is at stage `baseline`, not `axis+migrate` — so the
 * check moves there.
 */
const RECORDED_BASELINE_DIRTY_PORTABLE_ENTRYPOINTS = [
  ".",
  "./backend",
].toSorted();

/**
 * One witness chain per severance route still standing, as
 * `--grain=source --stage=<name>` prints it. R-axis and R-removals are
 * deleted from this table by this batch (§10 ruling (3)): both routes are
 * really severed now, so no chain to witness exists any more — see
 * {@link RECORDED_ABSENT_ROUTES} below, which replaces them with a
 * route-absent assertion at the exact stage/entrypoint each used to be
 * witnessed at. R-migrate is B3's route and is kept exactly as B1 recorded
 * it, unsevered.
 */
const RECORDED_ROUTE_CHAINS = {
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
} as const;

/**
 * Where R-axis and R-removals used to be witnessed, before this batch severed
 * them for real. `walk()` returns a CLEAN finding with neither `chain` nor
 * `specifier` for a route that no longer exists (its clean-return branch), so
 * asserting the absent chain — not just the "clean" verdict — is what proves
 * the entrypoint is clean for the right reason at the exact spot each route
 * used to be dirty, rather than merely "some entrypoint somewhere is clean."
 */
const RECORDED_ABSENT_ROUTES = {
  "R-axis": { stage: "baseline", entrypoint: "./core" },
  "R-removals": { stage: "axis+migrate", entrypoint: "." },
} as const;

/**
 * Recorded at HEAD by `pnpm build && TYPEGRAPH_REQUIRE_DIST_GRAIN=1 pnpm
 * vitest run tests/drizzle-reachability.test.ts` (a fresh build; the emitted
 * numbers, not B1's prediction) — 4 of 12 non-adapter entrypoints resolve a
 * Drizzle specifier at module load, in both artifact formats (they agree
 * entrywise; no entrypoint defers Drizzle behind a dynamic import yet). Every
 * predicted flip (`./core`, `./interchange`, `./schema`, `./graph-merge`,
 * `./provenance`: dirty -> clean) landed exactly as predicted, joining the
 * already-clean `./profiler`, `./indexes`, `./graph-extension`; `.`,
 * `./backend` (R-migrate's residue) and every adapter entrypoint stay dirty.
 */
const RECORDED_DIST_LOAD_VERDICTS: Readonly<
  Record<string, ReachabilityVerdict>
> = {
  ".": "dirty",
  "./backend": "dirty",
  "./core": "clean",
  "./interchange": "clean",
  "./profiler": "clean",
  "./schema": "clean",
  "./indexes": "clean",
  "./graph-extension": "clean",
  "./graph-merge": "clean",
  "./provenance": "clean",
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

  it("records today's source verdicts for all 18 entrypoints (4 of 12 non-adapter dirty: ., ./backend, ./sqlite/local, ./postgres/pglite)", () => {
    expect(RECORDED_TRUE_ADAPTER_ENTRYPOINTS.length).toBe(6);
    expect(RECORDED_NON_ADAPTER_ENTRYPOINTS.length).toBe(12);

    // Both-directions set equality, not a one-directional `.every`: a stray
    // flip either into or out of the recorded dirty set must fail.
    const dirtyNonAdapter = RECORDED_NON_ADAPTER_ENTRYPOINTS.filter(
      (entrypoint) => RECORDED_SOURCE_VERDICTS[entrypoint] === "dirty",
    ).toSorted();
    const cleanNonAdapter = RECORDED_NON_ADAPTER_ENTRYPOINTS.filter(
      (entrypoint) => RECORDED_SOURCE_VERDICTS[entrypoint] === "clean",
    ).toSorted();
    expect(dirtyNonAdapter).toEqual(RECORDED_DIRTY_NON_ADAPTER_ENTRYPOINTS);
    expect(cleanNonAdapter).toEqual(
      RECORDED_NON_ADAPTER_ENTRYPOINTS.filter(
        (entrypoint) =>
          !RECORDED_DIRTY_NON_ADAPTER_ENTRYPOINTS.includes(entrypoint),
      ).toSorted(),
    );

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

  it.each(Object.entries(RECORDED_ABSENT_ROUTES))(
    "no chain exists for severed route %s",
    (_route, witness) => {
      const stage = resolveSeveranceStage(witness.stage);
      const findings = scanSourceReachability({
        severedModules: stage.severedModules,
      });
      for (const mode of ["load", "deferred"] as const) {
        const finding = findings.find(
          (candidate) =>
            candidate.entrypoint === witness.entrypoint &&
            candidate.mode === mode,
        );
        expect(finding?.verdict, `${witness.entrypoint} (${mode})`).toBe(
          "clean",
        );
        expect(
          finding?.chain,
          `${witness.entrypoint} (${mode}) chain`,
        ).toBeUndefined();
        expect(
          finding?.specifier,
          `${witness.entrypoint} (${mode}) specifier`,
        ).toBeUndefined();
      }
    },
  );

  it("reproduces the staged-severance projection 2/10 -> 0/10 -> 0/10", () => {
    expect(RECORDED_PORTABLE_ENTRYPOINTS.length).toBe(10);

    for (const stage of SIMULATED_SEVERANCE_STAGES) {
      const dirtyCount = dirtyPortableEntrypointsAtStage(stage).length;
      expect({ [stage.name]: dirtyCount }).toEqual({
        [stage.name]: RECORDED_STAGE_DIRTY_COUNTS[stage.name],
      });
    }
  });

  it("names the two portable entrypoints still dirty at stage baseline (R-migrate's residue)", () => {
    const stage = resolveSeveranceStage("baseline");
    const dirty = dirtyPortableEntrypointsAtStage(stage).toSorted();
    expect(dirty).toEqual(RECORDED_BASELINE_DIRTY_PORTABLE_ENTRYPOINTS);
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
   *   where an entrypoint is dirty at source but clean at dist (before this
   *   batch: `./profiler`, `./indexes`, `./graph-extension`; today, after
   *   severing R-axis and R-removals, the source-dirty and dist-dirty
   *   non-adapter sets happen to coincide exactly — see the containment
   *   assertion below — but the property this guards is about every FUTURE
   *   divergence, not today's particular numbers).
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

  /**
   * I3's containment property, checked table against table rather than
   * table against a fresh scan: `RECORDED_DIST_LOAD_VERDICTS` is hand-edited
   * (recorded from a scan run separately, see its own doc comment) and
   * `RECORDED_SOURCE_VERDICTS` is hand-edited too, so nothing structurally
   * prevents the two from drifting apart independently. This is the guard
   * that keeps them honest against each other: dist reachability walks the
   * tree-shaken remainder of the SAME module graph source reachability
   * walks, so an entrypoint dirty at dist can never be clean at source — the
   * dist-dirty set is entrywise a subset of the source-dirty set.
   */
  it("the recorded dist-dirty set is entrywise a subset of the recorded source-dirty set", () => {
    const dirtyAtDistributionButNotSource = Object.keys(RECORDED_DIST_LOAD_VERDICTS)
      .filter(
        (entrypoint) => RECORDED_DIST_LOAD_VERDICTS[entrypoint] === "dirty",
      )
      .filter((entrypoint) => RECORDED_SOURCE_VERDICTS[entrypoint] !== "dirty");
    expect(
      dirtyAtDistributionButNotSource,
      "every entrypoint here is recorded dirty at dist but not at source",
    ).toEqual([]);
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

    it("records today's dist load verdicts in both formats (4 of 12 non-adapter dirty at load)", () => {
      const nonAdapterEntrypoints = Object.keys(
        RECORDED_DIST_LOAD_VERDICTS,
      ).filter((entrypoint) => !entrypoint.startsWith("./adapters/drizzle/"));
      expect(nonAdapterEntrypoints.length).toBe(12);
      const dirtyNonAdapter = nonAdapterEntrypoints
        .filter(
          (entrypoint) => RECORDED_DIST_LOAD_VERDICTS[entrypoint] === "dirty",
        )
        .toSorted();
      expect(dirtyNonAdapter).toEqual(RECORDED_DIRTY_NON_ADAPTER_ENTRYPOINTS);
      const cleanNonAdapter = nonAdapterEntrypoints
        .filter(
          (entrypoint) => RECORDED_DIST_LOAD_VERDICTS[entrypoint] === "clean",
        )
        .toSorted();
      expect(cleanNonAdapter).toEqual([
        "./core",
        "./graph-extension",
        "./graph-merge",
        "./indexes",
        "./interchange",
        "./profiler",
        "./provenance",
        "./schema",
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
