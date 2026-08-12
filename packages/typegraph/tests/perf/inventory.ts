/**
 * The `tests/perf/` manifest: every fixture registered with its mode, engines,
 * a guarded regression it exists to catch, and a named mutation — the
 * I-INVENTORY invariant's data, checked against two live scans by
 * `perf-fixture-inventory.test.ts` so the manifest cannot silently drift from
 * the directory it describes or the oracle it cross-references.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PERF_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ORACLE_FILE_PATH = path.join(
  PERF_DIRECTORY,
  "..",
  "write-plan-statement-order.test.ts",
);

export type PerfFixtureMode = "report" | "assert";
export type PerfFixtureEngine = "pglite" | "local-sqlite" | "server-postgres";

export type PerfFixture = Readonly<{
  /** Stable identifier, independent of the filename. */
  id: string;
  /** Filename under `tests/perf/`. */
  file: string;
  /** `"report"`: prints timings, asserts nothing, gated on `TYPEGRAPH_PERF=1`.
   *  `"assert"`: a normal, ungated CI test. */
  mode: PerfFixtureMode;
  /** Which database engine(s) this fixture exercises. */
  engines: readonly PerfFixtureEngine[];
  /** The regression this fixture guards against reintroducing. */
  guards: string;
  /** The deliberate mutation shown red-then-restored for this fixture. */
  mutation: string;
}>;

export const PERF_FIXTURES: readonly PerfFixture[] = [
  {
    id: "identity-current-traversal-scaling",
    file: "identity-current-traversal-scaling.test.ts",
    mode: "report",
    engines: ["local-sqlite", "server-postgres"],
    guards:
      "typegraph#270's correlated candidate-edge scan at the CURRENT read coordinate — an identity-expanded hop whose per-source rescan turns quadratic as the frontier or fan-out grows.",
    mutation:
      "Reverting the frontier-pin/equi-join fix #270 closed reproduces the correlated `EXISTS` rescan this fixture measures scaling superlinearly.",
  },
  {
    id: "identity-historical-traversal-scaling",
    file: "identity-historical-traversal-scaling.test.ts",
    mode: "report",
    engines: ["local-sqlite", "server-postgres"],
    guards:
      "typegraph#310's quadratic historical-reconstruction cost at a HISTORICAL read coordinate, isolated from #270's candidate-edge scan by measuring a narrow (fan-out 1) case separately from a broad one.",
    mutation:
      "Reverting the historical-reconstruction fix #310 closed reproduces the quadratic scaling this fixture's narrow-fan-out case measures.",
  },
  {
    id: "write-pipeline-statement-budget",
    file: "write-pipeline-statement-budget.test.ts",
    mode: "assert",
    engines: ["pglite", "local-sqlite"],
    guards:
      "A managed write's statement count growing silently — an extra schema-fence acquisition, a batch's claim statements scaling with row count instead of claim count, or a dropped post-insert claim — none of which any functional test can see, since a single writer enforces every constraint correctly regardless of how many statements it took.",
    mutation:
      "M1 (`issueClaimsBatched` swapped for `issueClaimsIndividually` in `withNodeCreateClaimsBatch`), M2 (`lockSchemaVersionForStoreWrite` called twice in `runInWriteTransaction`), M3 (the post-insert claim group dropped in `withNodeCreateClaimsIssuedBy`), M4 (an `ORACLE_COVERAGE_EXEMPTIONS` entry dropped) — each shown red-then-restored in the commit body.",
  },
  {
    id: "claim-fence-overhead",
    file: "claim-fence-overhead.test.ts",
    mode: "assert",
    engines: ["pglite", "local-sqlite"],
    guards:
      "The per-graph write fence or a claim statement being taken for a write that declared no constraint (I-ABSENT), or the fence/claim cost scaling with row count or with unrelated constraints rather than staying O(#claims) (I-CLAIM).",
    mutation:
      "M5 (`nodeWriteNeedsConstraintFence` in `src/store/constraints.ts` returns `true` unconditionally) and M6 (the uniqueness probe in `probeUniqueKey`, `src/store/claims/node-claims.ts`, issued twice per scope-member kind) — each shown red-then-restored in the commit body.",
  },
  {
    id: "perf-fixture-inventory",
    file: "perf-fixture-inventory.test.ts",
    mode: "assert",
    // A filesystem/text scan over this directory and `vitest.config.ts` —
    // no database engine, so this list is deliberately empty rather than
    // naming one it does not use.
    engines: [],
    guards:
      "This directory's own manifest silently drifting from what actually lives here: an unregistered fixture file, a registered file that no longer exists, or a fixture whose declared mode does not match its actual TYPEGRAPH_PERF gating.",
    mutation:
      "Adding an unregistered file under tests/perf/ (or removing a registered one) fails this suite's set-equality check against scanPerfFixtureFiles(); removing a report-mode fixture's TYPEGRAPH_PERF gate fails its gating check.",
  },
];

/** Every `*.test.ts` file under `tests/perf/`, including this manifest's own consumers. */
export function scanPerfFixtureFiles(): readonly string[] {
  return readdirSync(PERF_DIRECTORY)
    .filter((name) => name.endsWith(".test.ts"))
    .toSorted();
}

/**
 * `entryPoint: "..."` values from the statement-order oracle
 * (`tests/write-plan-statement-order.test.ts`), read-only: that file's own
 * header forbids editing it, so this is a live scan of ITS text, never a
 * copied list that could drift from what the oracle actually names. Matches
 * `\s*` across the newline the multi-line case in that file wraps onto, and
 * deliberately does not match the `entryPoint: string;` type member (no
 * quote follows the colon there) — 24 matches today, not 25.
 */
const ENTRY_POINT_PATTERN = /entryPoint:\s*"([^"]+)"/g;

export function scanOracleEntryPoints(): readonly string[] {
  const oracleSource = readFileSync(ORACLE_FILE_PATH, "utf8");
  return [...oracleSource.matchAll(ENTRY_POINT_PATTERN)].map((match) => {
    const entryPoint = match[1];
    if (entryPoint === undefined) {
      throw new Error(
        `ENTRY_POINT_PATTERN matched with no captured group: ${match[0]}`,
      );
    }
    return entryPoint;
  });
}
