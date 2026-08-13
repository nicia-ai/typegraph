import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveRepoRoot } from "../../src/git";
import {
  assertSeedPatchApplies,
  assertSeedPatchScope,
  parsePatchTargets,
  SeedPatchDoesNotApplyError,
  SeedPatchScopeError,
} from "../../src/regression/proof/patch";
import {
  REGRESSION_SEEDS,
  resolveSeed,
  UnknownSeedIdError,
  type RegressionSeed,
  type SeedId,
} from "../../src/regression/proof/seeds";

const repoRoot = resolveRepoRoot();

function firstSeed(): RegressionSeed {
  const [seed] = REGRESSION_SEEDS;
  if (seed === undefined) {
    throw new Error("No seeds registered in REGRESSION_SEEDS.");
  }
  return seed;
}

describe("parsePatchTargets", () => {
  it("extracts repo-relative paths from the real seed patch's +++ b/ and --- a/ headers", () => {
    const seed = firstSeed();
    const patchText = readFileSync(
      path.join(repoRoot, seed.patchFile),
      "utf-8",
    );
    const targets = parsePatchTargets(patchText);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.startsWith("packages/typegraph/src/query/compiler/")).toBe(
        true,
      );
    }
  });
});

describe("seed patch freshness (I-SEED-FRESH)", () => {
  it("every registered seed's patch file exists and still applies to this tree", () => {
    for (const seed of REGRESSION_SEEDS) {
      const patchPath = path.join(repoRoot, seed.patchFile);
      expect(() => readFileSync(patchPath, "utf-8")).not.toThrow();
      expect(() => assertSeedPatchApplies(seed, repoRoot)).not.toThrow();
    }
  });

  it("names the regeneration command when a patch no longer applies", () => {
    const seed = firstSeed();
    const originalPatchText = readFileSync(
      path.join(repoRoot, seed.patchFile),
      "utf-8",
    );
    // Corrupt exactly one context line (a unified-diff line starting with a
    // single space) so the patch text is well-formed but no longer matches
    // the tree it targets — this is "SEED-ROT" (spec §5 test 1's mutation).
    const corruptedPatchText = originalPatchText.replace(
      /^ .+$/mu,
      " this context line no longer matches anything in the tree",
    );
    expect(corruptedPatchText).not.toBe(originalPatchText);

    const scratchDir = mkdtempSync(path.join(os.tmpdir(), "seed-rot-"));
    const corruptedPatchPath = path.join(scratchDir, "corrupted.patch");
    writeFileSync(corruptedPatchPath, corruptedPatchText, "utf-8");
    const corruptedSeed: RegressionSeed = {
      ...seed,
      patchFile: path.relative(repoRoot, corruptedPatchPath),
    };

    expect(() => assertSeedPatchApplies(corruptedSeed, repoRoot)).toThrowError(
      SeedPatchDoesNotApplyError,
    );
    try {
      assertSeedPatchApplies(corruptedSeed, repoRoot);
      expect.fail("expected assertSeedPatchApplies to throw");
    } catch (error) {
      expect((error as Error).message).toContain("git diff HEAD 317f73d^");
    }
  });
});

describe("assertSeedPatchScope (I-SEED-SCOPE)", () => {
  it("refuses a seed patch that touches anything outside its declared prefixes", () => {
    const seed = firstSeed();
    const patchText = [
      "diff --git a/packages/typegraph/tests/perf/explain/identity-frontier-expansion.test.ts b/packages/typegraph/tests/perf/explain/identity-frontier-expansion.test.ts",
      "index 0000000..1111111 100644",
      "--- a/packages/typegraph/tests/perf/explain/identity-frontier-expansion.test.ts",
      "+++ b/packages/typegraph/tests/perf/explain/identity-frontier-expansion.test.ts",
      "@@ -1,1 +1,1 @@",
      "-const FRONTIER_ROW_CEILING = 100;",
      "+const FRONTIER_ROW_CEILING = 100000;",
    ].join("\n");
    expect(() => assertSeedPatchScope(seed, patchText)).toThrowError(
      SeedPatchScopeError,
    );
  });

  it("accepts the real seed patch, which stays within its declared scope", () => {
    const seed = firstSeed();
    const patchText = readFileSync(
      path.join(repoRoot, seed.patchFile),
      "utf-8",
    );
    expect(() => assertSeedPatchScope(seed, patchText)).not.toThrow();
  });
});

describe("REGRESSION_SEEDS", () => {
  it("declares a lane, label, baseline, severity and at least one must-fail and must-pass expectation for every seed", () => {
    for (const seed of REGRESSION_SEEDS) {
      expect(seed.timing.laneId.length).toBeGreaterThan(0);
      expect(seed.timing.label.length).toBeGreaterThan(0);
      expect(["tag", "base", "feature"]).toContain(seed.timing.baseline);
      expect(["flagged", "failed"]).toContain(seed.timing.classification);
      expect(seed.explain.mustFail.length).toBeGreaterThan(0);
      expect(seed.explain.mustPass.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveSeed", () => {
  it("resolves a registered id to its seed definition", () => {
    const seed = firstSeed();
    const seedId: SeedId = "identity-frontier-396";
    expect(seed.id).toBe(seedId);
    expect(resolveSeed(seedId)).toBe(seed);
  });

  it("rejects an unknown id naming every valid id", () => {
    expect(() => resolveSeed("bogus")).toThrowError(UnknownSeedIdError);
    try {
      resolveSeed("bogus");
      expect.fail("expected resolveSeed to throw");
    } catch (error) {
      for (const seed of REGRESSION_SEEDS) {
        expect((error as Error).message).toContain(seed.id);
      }
    }
  });
});
