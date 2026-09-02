/**
 * I2/I3 baseline ratchet — records today's measured Drizzle-reachability
 * numbers (source grain and dist grain) as executable data. Every
 * `RECORDED_*` constant below is a fact about the tree at the point it was
 * last measured, with the command that produced it named beside it.
 * `RECORDED_SOURCE_VERDICTS` and `RECORDED_DIST_VERDICTS` share a per-mode
 * verdict tuple shape so every recorded table in this file answers "clean or
 * dirty at THIS mode" rather than a single collapsed verdict.
 *
 * `./adapters/drizzle/engine` added a fourth classification,
 * `adapter-type-only` (`scripts/drizzle-reachability-scan.ts`): its runtime
 * value never imports Drizzle, but the profile types it also exports are
 * built from Drizzle-derived shapes, which this walker's `type`-only-blind
 * edge extraction reports dirty at source grain while a real build's erasure
 * of `export type` keeps the compiled artifact clean at dist grain — the
 * one entrypoint whose source and dist verdicts genuinely diverge.
 * `expectedVerdictsForClassification` takes a `grain` argument for exactly
 * this entrypoint; every other classification answers the same tuple at
 * both grains, as before. `RECORDED_TRUE_ADAPTER_ENTRYPOINTS` is now
 * classification-derived (`adapter-static`) rather than a `./adapters/
 * drizzle/` prefix match, so this one entrypoint — same prefix, different
 * measured behavior — does not join the "eagerly dirty at both grains"
 * grouping it no longer belongs to.
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

/** Headroom for the cold repository scan when V8 coverage instruments it. */
const REPOSITORY_SCAN_TIMEOUT_MS = 30_000;

/**
 * Recorded at HEAD by `node --import tsx
 * scripts/drizzle-reachability-scan.ts --grain=source` — every published
 * entrypoint, classified. Ten portable, six eagerly-dirty `adapter-static`
 * entrypoints, two "batteries included" `adapter-dynamic-only` entrypoints,
 * and one `adapter-type-only` entrypoint (`./adapters/drizzle/engine`)
 * whose runtime value never imports a Drizzle package but whose exported
 * types are built from Drizzle-derived shapes.
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
  "./sqlite/local": "adapter-dynamic-only",
  "./postgres/pglite": "adapter-dynamic-only",
  "./adapters/drizzle/sqlite": "adapter-static",
  "./adapters/drizzle/postgres": "adapter-static",
  "./adapters/drizzle/postgres/pglite": "adapter-static",
  "./adapters/drizzle/sqlite/local": "adapter-static",
  "./adapters/drizzle/sqlite/libsql": "adapter-static",
  "./adapters/drizzle/indexes": "adapter-static",
  "./adapters/drizzle/engine": "adapter-type-only",
};

const RECORDED_ENTRYPOINTS = Object.keys(RECORDED_CLASSIFICATIONS);
/**
 * The entrypoints expected to reach Drizzle eagerly at every grain and
 * mode — classification-derived (`adapter-static`), not a `./adapters/
 * drizzle/` prefix match, because `./adapters/drizzle/engine` shares the
 * prefix but is `adapter-type-only`: dirty at source grain, clean at dist
 * grain (see the module doc comment).
 */
const RECORDED_TRUE_ADAPTER_ENTRYPOINTS = RECORDED_ENTRYPOINTS.filter(
  (entrypoint) => RECORDED_CLASSIFICATIONS[entrypoint] === "adapter-static",
);
const RECORDED_NON_ADAPTER_ENTRYPOINTS = RECORDED_ENTRYPOINTS.filter(
  (entrypoint) => !entrypoint.startsWith("./adapters/drizzle/"),
);
const RECORDED_PORTABLE_ENTRYPOINTS = RECORDED_ENTRYPOINTS.filter(
  (entrypoint) => RECORDED_CLASSIFICATIONS[entrypoint] === "portable",
);

/**
 * Recorded at HEAD by `--grain=source` (`16 / 38 dirty`), as a per-mode
 * verdict TUPLE — mirroring {@link RECORDED_DIST_VERDICTS}'s shape — rather
 * than a single collapsed verdict, since not every entrypoint agrees across
 * modes: `./sqlite/local` and `./postgres/pglite`'s factories construct
 * their connection behind `await import("./*-store-impl")`, so `load`
 * (static edges only) is clean for both while `deferred` (every edge) stays
 * dirty. Every portable entrypoint is clean at both modes; every true
 * `adapter-static` `./adapters/drizzle/*` entrypoint stays dirty at both
 * modes by design; `./adapters/drizzle/engine` (`adapter-type-only`) is also
 * dirty at both modes here, purely from its type-only edges into
 * Drizzle-derived shapes (its dist-grain verdict, where those edges are
 * erased, is the opposite — see {@link RECORDED_DIST_VERDICTS}).
 */
const RECORDED_SOURCE_VERDICTS: Readonly<
  Record<
    string,
    Readonly<{ load: ReachabilityVerdict; deferred: ReachabilityVerdict }>
  >
> = {
  // R-migrate severed by B3 (`src/backend/migrate-recorded-time.ts` and
  // `src/backend/migrate-vectors.ts` no longer import Drizzle).
  ".": { load: "clean", deferred: "clean" },
  "./backend": { load: "clean", deferred: "clean" },
  // R-axis severed by B2 (`src/store/claims/axis.ts` no longer imports
  // `drizzle-orm`).
  "./core": { load: "clean", deferred: "clean" },
  // R-removals severed by B2 (`src/store/materialize-removals.ts` no
  // longer imports the adapter-owned builders).
  "./interchange": { load: "clean", deferred: "clean" },
  "./profiler": { load: "clean", deferred: "clean" },
  "./schema": { load: "clean", deferred: "clean" },
  "./indexes": { load: "clean", deferred: "clean" },
  "./graph-extension": { load: "clean", deferred: "clean" },
  "./graph-merge": { load: "clean", deferred: "clean" },
  "./provenance": { load: "clean", deferred: "clean" },
  // "Batteries included" entrypoints: re-classified `adapter-dynamic-only`
  // in THIS batch (B4b) — their connection construction moved behind a
  // dynamic import, so `load` is clean and `deferred` stays dirty.
  "./sqlite/local": { load: "clean", deferred: "dirty" },
  "./postgres/pglite": { load: "clean", deferred: "dirty" },
  // True adapter entrypoints: expected to reach Drizzle eagerly, at both
  // modes (ADAPTER_ENTRYPOINTS).
  "./adapters/drizzle/sqlite": { load: "dirty", deferred: "dirty" },
  "./adapters/drizzle/postgres": { load: "dirty", deferred: "dirty" },
  "./adapters/drizzle/postgres/pglite": { load: "dirty", deferred: "dirty" },
  "./adapters/drizzle/sqlite/local": { load: "dirty", deferred: "dirty" },
  "./adapters/drizzle/sqlite/libsql": { load: "dirty", deferred: "dirty" },
  "./adapters/drizzle/indexes": { load: "dirty", deferred: "dirty" },
  // `adapter-type-only`: dirty at source grain in both modes, purely from
  // type-only edges into Drizzle-derived shapes (see the module doc comment).
  "./adapters/drizzle/engine": { load: "dirty", deferred: "dirty" },
};

/**
 * `noUncheckedIndexedAccess` types `RECORDED_SOURCE_VERDICTS[entrypoint]` as
 * possibly `undefined`, so a second index (`.load`/`.deferred`) off that
 * result does not typecheck. Every entrypoint IS recorded (asserted
 * elsewhere), so this throws rather than silently narrowing with `!` —
 * mirroring {@link distributionVerdictsFor} below.
 */
function sourceVerdictsFor(
  entrypoint: string,
): Readonly<{ load: ReachabilityVerdict; deferred: ReachabilityVerdict }> {
  const verdicts = RECORDED_SOURCE_VERDICTS[entrypoint];
  if (verdicts === undefined) {
    throw new Error(
      `RECORDED_SOURCE_VERDICTS has no entry for ${JSON.stringify(entrypoint)}.`,
    );
  }
  return verdicts;
}

/**
 * The expected per-mode verdict tuple for a classification at one grain —
 * the single owner of "what classification implies about verdicts", so the
 * derived assertions below (source grain, ungated; dist grain, both
 * formats) bind `classifyEntrypoints()`'s real output to a measured scan
 * rather than re-deriving the expectation inline at each call site. Every
 * classification but `adapter-type-only` answers the same tuple at both
 * grains; `adapter-type-only` genuinely diverges (dirty at source, clean at
 * dist — see the module doc comment), which is why `grain` is a parameter
 * here rather than folded into the classification alone.
 */
function expectedVerdictsForClassification(
  classification: EntrypointClassification,
  grain: "source" | "dist",
): Readonly<{ load: ReachabilityVerdict; deferred: ReachabilityVerdict }> {
  switch (classification) {
    case "portable": {
      return { load: "clean", deferred: "clean" };
    }
    case "adapter-static": {
      return { load: "dirty", deferred: "dirty" };
    }
    case "adapter-dynamic-only": {
      return { load: "clean", deferred: "dirty" };
    }
    case "adapter-type-only": {
      return grain === "source" ?
          { load: "dirty", deferred: "dirty" }
        : { load: "clean", deferred: "clean" };
    }
  }
}

/**
 * `noUncheckedIndexedAccess` types a plain index into `classifyEntrypoints()`'s
 * result as possibly `undefined`. Every entrypoint in {@link RECORDED_ENTRYPOINTS}
 * IS classified (asserted by "classifies every published entrypoint and
 * nothing else" above), so this throws rather than silently narrowing.
 */
function classificationFor(
  classifications: Readonly<Record<string, EntrypointClassification>>,
  entrypoint: string,
): EntrypointClassification {
  const classification = classifications[entrypoint];
  if (classification === undefined) {
    throw new Error(`No classification for ${JSON.stringify(entrypoint)}.`);
  }
  return classification;
}

/**
 * The two non-adapter entrypoints classified `adapter-dynamic-only` — the
 * "batteries included" adapters, now that their connection construction is
 * deferred behind a dynamic import (B4b). Replaces the pre-B4b
 * `RECORDED_DIRTY_NON_ADAPTER_ENTRYPOINTS`, which asserted against a single
 * collapsed verdict that no longer exists for these two entrypoints.
 */
const RECORDED_DYNAMIC_ONLY_ENTRYPOINTS = [
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
 * --grain=dist` (a fresh build; the emitted `28 / 76 dirty`, not a
 * prediction) — I3's per-mode verdict TUPLE, not a single `load` verdict.
 * All ten portable entrypoints are clean at both `load` and `deferred`, in
 * both artifact formats. The six true `adapter-static` `./adapters/drizzle/*`
 * entrypoints are dirty at both modes, in both formats. The two "batteries
 * included" entrypoints (`./sqlite/local`, `./postgres/pglite`) are clean at
 * `load` and dirty at `deferred`, in BOTH formats — measured against
 * `tsup@8.5.1`'s real `splitting: true` output: the ESM artifact's factory body is
 * `await import('./local-store-impl-HASH.js')`, landing in its own chunk,
 * and the CJS artifact's factory body is the equivalent
 * `await import('./local-store-impl-HASH.cjs')` (a genuine dynamic
 * `ImportExpression`, not a `require`), also in its own chunk — so Node's
 * module loader never resolves `drizzle-orm` for either format unless the
 * factory actually runs, which is exactly what makes the missing-peer typed
 * refusal in `src/backend/missing-peer-ledger.ts` reachable in the shipped
 * artifact. `./adapters/drizzle/engine` (`adapter-type-only`) is clean at
 * both modes, in both formats: its compiled artifact contains only the
 * re-exported factory value, which never imports Drizzle (see the module
 * doc comment for why its source-grain verdict differs).
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
  "./sqlite/local": { load: "clean", deferred: "dirty" },
  "./postgres/pglite": { load: "clean", deferred: "dirty" },
  "./adapters/drizzle/sqlite": { load: "dirty", deferred: "dirty" },
  "./adapters/drizzle/postgres": { load: "dirty", deferred: "dirty" },
  "./adapters/drizzle/postgres/pglite": { load: "dirty", deferred: "dirty" },
  "./adapters/drizzle/sqlite/local": { load: "dirty", deferred: "dirty" },
  "./adapters/drizzle/sqlite/libsql": { load: "dirty", deferred: "dirty" },
  "./adapters/drizzle/indexes": { load: "dirty", deferred: "dirty" },
  "./adapters/drizzle/engine": { load: "clean", deferred: "clean" },
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

  it(
    "records today's source verdicts for all 19 entrypoints in both modes (2 of 12 non-adapter adapter-dynamic-only: ./sqlite/local, ./postgres/pglite)",
    { timeout: REPOSITORY_SCAN_TIMEOUT_MS },
    () => {
      expect(RECORDED_TRUE_ADAPTER_ENTRYPOINTS.length).toBe(6);
      expect(RECORDED_NON_ADAPTER_ENTRYPOINTS.length).toBe(12);

      // Both-directions set equality against the CLASSIFICATION table, not a
      // one-directional `.every`: a stray flip either into or out of the
      // recorded `adapter-dynamic-only` set must fail. (Pre-B4b this compared
      // against a single collapsed verdict; the two batteries entrypoints no
      // longer agree across modes, so "dirty" is no longer a well-defined
      // question without naming a mode.)
      const dynamicOnlyNonAdapter = RECORDED_NON_ADAPTER_ENTRYPOINTS.filter(
        (entrypoint) =>
          RECORDED_CLASSIFICATIONS[entrypoint] === "adapter-dynamic-only",
      ).toSorted();
      const portableNonAdapter = RECORDED_NON_ADAPTER_ENTRYPOINTS.filter(
        (entrypoint) => RECORDED_CLASSIFICATIONS[entrypoint] === "portable",
      ).toSorted();
      expect(dynamicOnlyNonAdapter).toEqual(RECORDED_DYNAMIC_ONLY_ENTRYPOINTS);
      expect(portableNonAdapter).toEqual(
        RECORDED_NON_ADAPTER_ENTRYPOINTS.filter(
          (entrypoint) =>
            !RECORDED_DYNAMIC_ONLY_ENTRYPOINTS.includes(entrypoint),
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
            sourceVerdictsFor(entrypoint)[mode],
          );
        }
      }
    },
  );

  /**
   * I2/I3's derived binding, at SOURCE grain: `classifyEntrypoints()`'s real
   * output implies the measured verdict tuple `scanSourceReachability()`
   * reports, for every published entrypoint, at both modes — not merely that
   * the two hand-edited recorded tables (`RECORDED_CLASSIFICATIONS`,
   * `RECORDED_SOURCE_VERDICTS`) agree with each other. This is what makes a
   * regression that reintroduces a static Drizzle-reaching edge into one of
   * the two `adapter-dynamic-only` entrypoints (reverting the impl-module
   * split) fail here, naming the entrypoint, its classification, and the
   * mode, rather than only in the hand-edited-table cross-check above.
   */
  it("binds classifyEntrypoints() to the measured source verdict tuple at both modes", () => {
    const classification = classifyEntrypoints();
    const findings = scanSourceReachability();

    for (const entrypoint of RECORDED_ENTRYPOINTS) {
      const entrypointClassification = classificationFor(
        classification,
        entrypoint,
      );
      const expected = expectedVerdictsForClassification(
        entrypointClassification,
        "source",
      );
      for (const mode of ["load", "deferred"] as const) {
        const finding = findings.find(
          (candidate) =>
            candidate.entrypoint === entrypoint && candidate.mode === mode,
        );
        expect(
          finding?.verdict,
          `${entrypoint} (${mode}), classified ${entrypointClassification}`,
        ).toBe(expected[mode]);
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
          (entrypoint) => sourceVerdictsFor(entrypoint)[mode] !== "dirty",
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
    it("covers both artifact formats of all 19 entrypoints", () => {
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

    it("records the load and deferred dist verdicts for all 19 entrypoints in both formats (0 of 10 portable dirty at either mode; 2 of 9 adapter entrypoints adapter-dynamic-only: load clean, deferred dirty)", () => {
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

      // The six true `./adapters/drizzle/*` entrypoints are recorded dirty
      // at BOTH modes — they reach Drizzle eagerly, with no dynamic import.
      const dirtyTrueAdapterAtBothModes =
        RECORDED_TRUE_ADAPTER_ENTRYPOINTS.filter(
          (entrypoint) =>
            distributionVerdictsFor(entrypoint).load === "dirty" &&
            distributionVerdictsFor(entrypoint).deferred === "dirty",
        ).toSorted();
      expect(dirtyTrueAdapterAtBothModes).toEqual(
        RECORDED_TRUE_ADAPTER_ENTRYPOINTS.toSorted(),
      );

      // The two "batteries included" entrypoints are recorded clean at
      // `load` and dirty at `deferred` — the ONLY direction the mode
      // containment test below permits, and what makes the missing-peer
      // typed refusal reachable in a shipped artifact at all (I12).
      for (const entrypoint of RECORDED_DYNAMIC_ONLY_ENTRYPOINTS) {
        expect(
          distributionVerdictsFor(entrypoint),
          `dist verdicts for ${entrypoint}`,
        ).toEqual({
          load: "clean",
          deferred: "dirty",
        });
      }

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

    /**
     * I2/I3's derived binding, at DIST grain, in BOTH artifact formats:
     * `classifyEntrypoints()`'s real output implies the MEASURED verdict
     * tuple `scanDistReachability()` reports for a fresh build, for every
     * published entrypoint. This is what would catch `tsup.config.ts`'s
     * `splitting: false` (T17's mutation) failing to keep the dynamic import
     * in its own chunk: both formats' `load` verdicts for both "batteries
     * included" entrypoints would turn dirty, disagreeing with the
     * `adapter-dynamic-only` classification's `load: "clean"` expectation.
     */
    it("binds classifyEntrypoints() to the measured dist verdict tuple in both formats", () => {
      const classification = classifyEntrypoints();
      const findings = scanDistributionReachability();

      for (const entrypoint of RECORDED_ENTRYPOINTS) {
        const entrypointClassification = classificationFor(
          classification,
          entrypoint,
        );
        const expected = expectedVerdictsForClassification(
          entrypointClassification,
          "dist",
        );
        for (const format of ["import", "require"] as const) {
          for (const mode of ["load", "deferred"] as const) {
            const match = findings.find(
              (finding) =>
                finding.entrypoint === entrypoint &&
                finding.format === format &&
                finding.mode === mode,
            );
            expect(
              match?.verdict,
              `${entrypoint} [${format}] (${mode}), classified ${entrypointClassification}`,
            ).toBe(expected[mode]);
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
