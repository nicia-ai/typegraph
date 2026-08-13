/**
 * I2/I3 baseline ratchet — records today's measured Drizzle-reachability
 * numbers (source grain and dist grain) as executable data. Every
 * `RECORDED_*` constant below is a fact about the tree at the point it was
 * last measured, with the command that produced it named beside it, per
 * `design-ws8-port-isolation.md` §2.1. B3 severs R-migrate
 * (`src/backend/migrate-recorded-time.ts` / `migrate-vectors.ts`), which was
 * the last real route reaching Drizzle from `.` and `./backend` — both flip
 * clean at both grains and both formats. This batch (B4) restructures the
 * dist table into a per-mode verdict tuple and re-measures it against a
 * fresh build (0 of 10 portable dirty at either mode, in both formats). A
 * later batch (B4b) flips the remaining two "batteries included" adapter
 * entrypoints from `dirty` to the `adapter-dynamic-only` classification.
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
 * Recorded at HEAD by `--grain=source` (`16 / 36 dirty`) — an explicit,
 * per-entrypoint table with a reason for each row, replacing B1's "every
 * entrypoint is dirty" derivation now that R-axis
 * (`src/store/claims/axis.ts`), R-removals
 * (`src/store/materialize-removals.ts`) and R-migrate
 * (`src/backend/migrate-recorded-time.ts` / `migrate-vectors.ts`) are all
 * severed. Zero portable entrypoints remain dirty; every adapter entrypoint
 * stays dirty by design (§3.1, §4.6).
 */
const RECORDED_SOURCE_VERDICTS: Readonly<Record<string, ReachabilityVerdict>> =
  {
    // R-migrate severed in THIS batch (B3):
    // `src/backend/migrate-recorded-time.ts` and
    // `src/backend/migrate-vectors.ts` no longer import Drizzle.
    ".": "clean",
    "./backend": "clean",
    // R-axis severed by B2 (`src/store/claims/axis.ts` no longer imports
    // `drizzle-orm`).
    "./core": "clean",
    // R-removals severed by B2 (`src/store/materialize-removals.ts` no
    // longer imports the adapter-owned builders).
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

/** The two non-adapter entrypoints still dirty at source grain — the "batteries included" adapters, now that R-migrate is severed. */
const RECORDED_DIRTY_NON_ADAPTER_ENTRYPOINTS = [
  "./sqlite/local",
  "./postgres/pglite",
].toSorted();

/**
 * Recorded at HEAD by `--grain=source --stage=<name>`, filtered to the ten
 * portable entrypoints at `load` mode. R-axis, R-removals and (as of this
 * batch) R-migrate are now REALLY severed (not simulated), so every stage —
 * including `baseline`, no simulated severance at all — reports zero dirty
 * portable entrypoints.
 */
const RECORDED_STAGE_DIRTY_COUNTS: Readonly<Record<string, number>> = {
  baseline: 0,
  "axis+migrate": 0,
  "axis+migrate+removals": 0,
};

/**
 * One witness chain for the adapter route that still reaches Drizzle, as
 * `--grain=source --stage=<name>` prints it. R-axis, R-removals and R-migrate
 * are all deleted from this table (§10 ruling (3), extended to R-migrate by
 * this batch): every severance route is really severed now, so no
 * severance-route chain to witness exists any more — see
 * {@link RECORDED_ABSENT_ROUTES} below, which carries the route-absent
 * assertions at the exact stage/entrypoint each used to be witnessed at.
 * Rather than leave this constant (and its `it.each`) empty — silently
 * dropping the suite's only chain-shape assertion — this repoints it at the
 * shortest chain for `./adapters/drizzle/sqlite`, an adapter entrypoint that
 * will always reach Drizzle by design. This is now a SCANNER-BEHAVIOUR
 * witness (the shortest-chain reporting still works), not a severance
 * witness.
 */
const RECORDED_ROUTE_CHAINS = {
  "./adapters/drizzle/sqlite": {
    stage: "baseline",
    entrypoint: "./adapters/drizzle/sqlite",
    mode: "load",
    chain: [
      {
        from: "src/backend/sqlite/index.ts",
        to: "src/backend/drizzle/sqlite.ts",
        kind: "static",
      },
      {
        from: "src/backend/drizzle/sqlite.ts",
        to: "drizzle-orm",
        kind: "static",
      },
    ],
  },
} as const;

/**
 * Where R-axis, R-removals and R-migrate used to be witnessed, before each
 * batch severed it for real. `walk()` returns a CLEAN finding with neither
 * `chain` nor `specifier` for a route that no longer exists (its clean-return
 * branch), so asserting the absent chain — not just the "clean" verdict — is
 * what proves the entrypoint is clean for the right reason at the exact spot
 * each route used to be dirty, rather than merely "some entrypoint somewhere
 * is clean."
 */
const RECORDED_ABSENT_ROUTES = {
  "R-axis": { stage: "baseline", entrypoint: "./core" },
  "R-removals": { stage: "axis+migrate", entrypoint: "." },
  "R-migrate": { stage: "baseline", entrypoint: "./backend" },
} as const;

/**
 * Recorded at HEAD by `rm -rf dist && NODE_OPTIONS=--max-old-space-size=8192
 * pnpm build`, then `node --import tsx scripts/drizzle-reachability-scan.ts
 * --grain=dist` (a fresh build; the emitted `32 / 72 dirty`, not a
 * prediction) — I3's per-mode verdict TUPLE, not a single `load` verdict:
 * all ten portable entrypoints are clean at both `load` and `deferred`, in
 * both artifact formats; all eight adapter entrypoints (the two "batteries
 * included" entrypoints plus every `./adapters/drizzle/*` entrypoint) are
 * dirty at both modes, in both formats — no entrypoint defers Drizzle behind
 * a dynamic import yet (that is B4b's `adapter-dynamic-only`
 * re-classification for the two batteries entrypoints), so `load` and
 * `deferred` agree everywhere today.
 */
const RECORDED_DIST_VERDICTS: Readonly<
  Record<
    string,
    Readonly<{ load: ReachabilityVerdict; deferred: ReachabilityVerdict }>
  >
> = {
  ".": { load: "clean", deferred: "clean" },
  "./backend": { load: "clean", deferred: "clean" },
  "./core": { load: "clean", deferred: "clean" },
  "./interchange": { load: "clean", deferred: "clean" },
  "./profiler": { load: "clean", deferred: "clean" },
  "./schema": { load: "clean", deferred: "clean" },
  "./indexes": { load: "clean", deferred: "clean" },
  "./graph-extension": { load: "clean", deferred: "clean" },
  "./graph-merge": { load: "clean", deferred: "clean" },
  "./provenance": { load: "clean", deferred: "clean" },
  "./sqlite/local": { load: "dirty", deferred: "dirty" },
  "./postgres/pglite": { load: "dirty", deferred: "dirty" },
  "./adapters/drizzle/sqlite": { load: "dirty", deferred: "dirty" },
  "./adapters/drizzle/postgres": { load: "dirty", deferred: "dirty" },
  "./adapters/drizzle/postgres/pglite": { load: "dirty", deferred: "dirty" },
  "./adapters/drizzle/sqlite/local": { load: "dirty", deferred: "dirty" },
  "./adapters/drizzle/sqlite/libsql": { load: "dirty", deferred: "dirty" },
  "./adapters/drizzle/indexes": { load: "dirty", deferred: "dirty" },
};

/**
 * `noUncheckedIndexedAccess` types `RECORDED_DIST_VERDICTS[entrypoint]` as
 * possibly `undefined`, so a second index (`[mode]`/`.load`/`.deferred`) off
 * that result does not typecheck. Every entrypoint IS recorded (asserted
 * elsewhere), so this throws rather than silently narrowing with `!`.
 */
function distributionVerdictsFor(
  entrypoint: string,
): Readonly<{ load: ReachabilityVerdict; deferred: ReachabilityVerdict }> {
  const verdicts = RECORDED_DIST_VERDICTS[entrypoint];
  if (verdicts === undefined) {
    throw new Error(
      `RECORDED_DIST_VERDICTS has no entry for ${JSON.stringify(entrypoint)}.`,
    );
  }
  return verdicts;
}

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

  it("records today's source verdicts for all 18 entrypoints (2 of 12 non-adapter dirty: ./sqlite/local, ./postgres/pglite)", () => {
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
    "names the shortest chain for the adapter entrypoint that still reaches Drizzle",
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

  it("reproduces the staged-severance projection 0/10 -> 0/10 -> 0/10", () => {
    expect(RECORDED_PORTABLE_ENTRYPOINTS.length).toBe(10);

    for (const stage of SIMULATED_SEVERANCE_STAGES) {
      const dirtyCount = dirtyPortableEntrypointsAtStage(stage).length;
      expect({ [stage.name]: dirtyCount }).toEqual({
        [stage.name]: RECORDED_STAGE_DIRTY_COUNTS[stage.name],
      });
    }
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
   * table against a fresh scan: `RECORDED_DIST_VERDICTS` is hand-edited
   * (recorded from a scan run separately, see its own doc comment) and
   * `RECORDED_SOURCE_VERDICTS` is hand-edited too, so nothing structurally
   * prevents the two from drifting apart independently. This is the guard
   * that keeps them honest against each other: dist reachability walks the
   * tree-shaken remainder of the SAME module graph source reachability
   * walks, so an entrypoint dirty at dist (at EITHER mode) can never be
   * clean at source — the dist-dirty set is entrywise a subset of the
   * source-dirty set, checked at both `load` and `deferred`.
   */
  it("the recorded dist-dirty set is entrywise a subset of the recorded source-dirty set, at both modes", () => {
    for (const mode of ["load", "deferred"] as const) {
      const dirtyAtDistributionButNotSource = Object.keys(
        RECORDED_DIST_VERDICTS,
      )
        .filter(
          (entrypoint) => distributionVerdictsFor(entrypoint)[mode] === "dirty",
        )
        .filter(
          (entrypoint) => RECORDED_SOURCE_VERDICTS[entrypoint] !== "dirty",
        );
      expect(
        dirtyAtDistributionButNotSource,
        `every entrypoint here is recorded dirty at dist (${mode}) but not at source`,
      ).toEqual([]);
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

    it("records the load and deferred dist verdicts for all 18 entrypoints in both formats (0 of 10 portable dirty at either mode)", () => {
      expect(Object.keys(RECORDED_DIST_VERDICTS).length).toBe(
        RECORDED_ENTRYPOINTS.length,
      );

      // Both directions on the ten truly portable entrypoints: none is
      // recorded dirty at either mode.
      const dirtyPortableAtEitherMode = RECORDED_PORTABLE_ENTRYPOINTS.filter(
        (entrypoint) =>
          distributionVerdictsFor(entrypoint).load === "dirty" ||
          distributionVerdictsFor(entrypoint).deferred === "dirty",
      );
      expect(dirtyPortableAtEitherMode).toEqual([]);

      // Every adapter entrypoint (the six true `./adapters/drizzle/*` plus
      // the two "batteries included" entrypoints) is recorded dirty at BOTH
      // modes — no entrypoint defers Drizzle behind a dynamic import yet.
      const dirtyAdapterAtBothModes = [
        ...RECORDED_TRUE_ADAPTER_ENTRYPOINTS,
        "./sqlite/local",
        "./postgres/pglite",
      ]
        .filter(
          (entrypoint) =>
            distributionVerdictsFor(entrypoint).load === "dirty" &&
            distributionVerdictsFor(entrypoint).deferred === "dirty",
        )
        .toSorted();
      expect(dirtyAdapterAtBothModes).toEqual(
        [
          ...RECORDED_TRUE_ADAPTER_ENTRYPOINTS,
          "./sqlite/local",
          "./postgres/pglite",
        ].toSorted(),
      );

      const findings = scanDistributionReachability();
      for (const [entrypoint, verdicts] of Object.entries(
        RECORDED_DIST_VERDICTS,
      )) {
        for (const format of ["import", "require"] as const) {
          for (const mode of ["load", "deferred"] as const) {
            const match = findings.find(
              (finding) =>
                finding.entrypoint === entrypoint &&
                finding.format === format &&
                finding.mode === mode,
            );
            expect(match?.verdict, `${entrypoint} [${format}] (${mode})`).toBe(
              verdicts[mode],
            );
          }
        }
      }
    });
  });

  /**
   * Mode containment on the DIST-grain table: `deferred` follows a strict
   * superset of the edges `load` follows, so an artifact dirty at `load`
   * must be recorded dirty at `deferred` too — the reverse (load-dirty,
   * deferred-clean) can never happen by construction. This is the assertion
   * that lets B4b's re-classification of the two "batteries included"
   * entrypoints (`load` turns clean, `deferred` stays dirty — the ONLY
   * direction this test permits) land as a reviewed diff in the recorded
   * table rather than an unreviewed one.
   */
  it("no artifact is recorded dirty at load and clean at deferred", () => {
    const loadDirtyDeferredClean = Object.entries(RECORDED_DIST_VERDICTS)
      .filter(
        ([, verdicts]) =>
          verdicts.load === "dirty" && verdicts.deferred === "clean",
      )
      .map(([entrypoint]) => entrypoint);
    expect(loadDirtyDeferredClean).toEqual([]);
  });

  it("refuses to skip the dist grain when TYPEGRAPH_REQUIRE_DIST_GRAIN=1", () => {
    expect(shouldSkipDistributionGrain(false, "1")).toBe(false);
    expect(shouldSkipDistributionGrain(true, "1")).toBe(false);
    expect(shouldSkipDistributionGrain(false, undefined)).toBe(true);
    expect(shouldSkipDistributionGrain(true, undefined)).toBe(false);
  });
});
