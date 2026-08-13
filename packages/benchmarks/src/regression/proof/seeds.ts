import { type BaselineId } from "../policy";

/**
 * The seeded-regression proof registry (WS0 batch B6). A seed is a reverse
 * patch that reintroduces a historical, already-fixed cost regression into a
 * scratch worktree so the harness built by B1-B5 can be pointed at a known
 * answer: does `bench:regression` flag it at the right severity, and does at
 * least one `tests/perf/explain/**` assertion catch the same shape
 * deterministically? See `src/regression-proof.ts` for the driver that
 * answers both questions and `docs/regression-mode.md`'s "Seeded-regression
 * proof" section for the write-up.
 */

export type SeedId = "identity-frontier-396";

/**
 * What the timing half of the proof must observe in the `bench:regression`
 * report: a `LaneComparison` for `(laneId, baseline)` containing a
 * measurement for `label` classified exactly as `classification`.
 */
export type SeedTimingExpectation = Readonly<{
  laneId: string;
  label: string;
  baseline: BaselineId;
  classification: "flagged" | "failed";
}>;

/**
 * One `tests/perf/explain/**` case the seed must turn red, and the substring
 * of its own thrown message that proves the failure is the seeded shape (not
 * an unrelated break — an import error or a timeout would also turn the case
 * red, but would not contain this diagnostic).
 */
export type ExplainFailureExpectation = Readonly<{
  titleFragments: readonly string[];
  diagnostic: string;
}>;

/**
 * The explain half of the proof: `testFile` (repo-relative to
 * `packages/typegraph`) must, under the seed, fail every `mustFail` case with
 * its declared diagnostic while every `mustPass` case still passes (the seed
 * is a cost regression, not a semantic break — I-SEED-SEMANTICS).
 */
export type SeedExplainExpectation = Readonly<{
  testFile: string;
  mustFail: readonly ExplainFailureExpectation[];
  /** Each entry is the set of title fragments identifying one passing case. */
  mustPass: readonly (readonly string[])[];
}>;

export type RegressionSeed = Readonly<{
  id: SeedId;
  /** Repo-relative path to the reverse patch. */
  patchFile: string;
  /** Every path the patch touches must start with one of these prefixes. */
  allowedPathPrefixes: readonly string[];
  /** Provenance: the fix commit(s) reverted and the regeneration command. */
  origin: string;
  description: string;
  timing: SeedTimingExpectation;
  explain: SeedExplainExpectation;
}>;

/**
 * The one registered seed: `317f73d` ("perf(query): bound current identity
 * expansion by the frontier, not the closure") fixed the #396/#432 shape
 * carried by its parent, `2562fe0`. This patch is `git diff HEAD 317f73d^`
 * over the three files `317f73d` touched — applying it reverts the fix and
 * restores the graph-wide `identity_peer_class` MATERIALIZED CTE at the
 * *current* coordinate (cost = sum of squares of every identity class).
 */
const IDENTITY_FRONTIER_396_SEED: RegressionSeed = {
  id: "identity-frontier-396",
  patchFile: "packages/benchmarks/etc/seeds/identity-frontier-396.patch",
  allowedPathPrefixes: ["packages/typegraph/src/query/compiler/"],
  origin:
    'Reverts "perf(query): bound current identity expansion by the ' +
    'frontier, not the closure" (317f73d13177a6976cba79ac74588abfcda8f2e0), ' +
    "whose parent 2562fe083f6ce3f3541d6e1698015a185a36193e carries the " +
    "#396/#432 shape. Regenerate with (from repo root): " +
    "git diff HEAD 317f73d^ -- " +
    "packages/typegraph/src/query/compiler/identity-traversal.ts " +
    "packages/typegraph/src/query/compiler/recursive.ts " +
    "packages/typegraph/src/query/compiler/emitter/standard-builders.ts " +
    "> packages/benchmarks/etc/seeds/identity-frontier-396.patch",
  description:
    "Restores the graph-wide identity_peer_class MATERIALIZED CTE at the " +
    "current read coordinate, so a current-coordinate identity-expanded hop " +
    "pays for every identity class in the graph instead of only the ones " +
    "its frontier touches.",
  timing: {
    laneId: "identity-frontier",
    label: "identity-frontier:current-hop",
    baseline: "base",
    classification: "failed",
  },
  explain: {
    testFile: "tests/perf/explain/identity-frontier-expansion.test.ts",
    mustFail: [
      {
        titleFragments: [
          "sqlite",
          "seeks the identity closure from the frontier",
        ],
        diagnostic: "required term SEARCH identity_seed_class",
      },
      {
        titleFragments: [
          "postgres",
          "visits at most FRONTIER_ROW_CEILING rows expanding the frontier",
        ],
        diagnostic: "visited rows exceeds ceiling 100",
      },
    ],
    mustPass: [
      ["sqlite", "reaches the target through an identity peer"],
      ["postgres", "reaches the target through an identity peer"],
    ],
  },
};

export const REGRESSION_SEEDS: readonly RegressionSeed[] = [
  IDENTITY_FRONTIER_396_SEED,
];

export class UnknownSeedIdError extends Error {
  constructor(seedId: string, validIds: readonly string[]) {
    super(
      `Unknown regression seed id: "${seedId}". Valid ids: ${validIds.join(", ")}.`,
    );
    this.name = "UnknownSeedIdError";
  }
}

/** Resolves `id` to its registered seed; throws, naming every valid id, otherwise. */
export function resolveSeed(id: string): RegressionSeed {
  const validIds = REGRESSION_SEEDS.map((seed) => seed.id);
  const seed = REGRESSION_SEEDS.find((candidate) => candidate.id === id);
  if (seed === undefined) {
    throw new UnknownSeedIdError(id, validIds);
  }
  return seed;
}
