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
    id: "identity-frontier-expansion",
    file: "explain/identity-frontier-expansion.test.ts",
    mode: "assert",
    engines: ["pglite", "local-sqlite"],
    guards:
      "typegraph#396's quadratic identity-frontier expansion reintroduced as a correlated `identity_peer` scan that loses its `class_kind`/`class_id` join boundary — the #396 shape mechanized as a deterministic EXPLAIN plan-shape check instead of a timing threshold.",
    mutation:
      "FRONTIER-PIN (dropping `class_kind`/`class_id` from the `identity_peer` join in `planCurrentIdentityFrontierExpansion`, `src/query/compiler/identity-traversal.ts`) measured 495 visited rows against the 100-row `FRONTIER_ROW_CEILING` (HEAD actual 18); FRONTIER-MATERIALIZE (forcing the historical branch unconditionally) is inconclusive at this coordinate, so FRONTIER-PIN is the load-bearing mutation. Both shown red-then-restored in the commit body.",
  },
  {
    id: "variable-length-traversal",
    file: "explain/variable-length-traversal.test.ts",
    mode: "assert",
    engines: ["pglite", "local-sqlite"],
    guards:
      "typegraph#391's variable-length/recursive traversal losing its recursive worktable's equi-join or its depth cap — degrading a bounded walk into a cross join, or silently extending it past its configured maximum depth.",
    mutation:
      "RECURSIVE-WORKTABLE-JOIN (blinding `compileWorktableJoinClauses`'s `edgeId` equality, `src/query/compiler/recursive.ts`) measured 852,419 visited rows against the 2,250-row `RECURSIVE_ROW_CEILING` (a reduced-scale reproduction — the mutation is intractable to run to completion at the committed fixture size); RECURSIVE-DEPTH-CAP (forcing `effectiveMaxDepth` to `MAX_RECURSIVE_DEPTH` in `compileRecursiveCte`) measured 20,478 visited rows against the same 2,250 ceiling (HEAD actual 448). Both shown red-then-restored in the commit body.",
  },
  {
    id: "coalesce-probe",
    file: "explain/coalesce-probe.test.ts",
    mode: "assert",
    engines: ["pglite", "local-sqlite"],
    guards:
      "the coalescing upsert probe losing its primary-key seek and degrading to a table scan, or a bulk upsert's batched probe losing its keyed `IN (...)` seek.",
    mutation:
      "COALESCE-PROBE-KEY (dropping the `id IN (...)` term from `buildGetNodes`, `src/backend/drizzle/operations/nodes.ts`) measured 5,000 visited rows against the 8-row `COALESCE_PROBE_ROW_CEILING` — the whole seeded population, on Postgres; COALESCE-BATCH-FANOUT (forcing `bulkUpsertById`'s per-item fallback in `upsertAll`) reddens the bulk-batch statement-count case. Both shown red-then-restored in the commit body.",
  },
  {
    id: "claim-upsert",
    file: "explain/claim-upsert.test.ts",
    mode: "assert",
    engines: ["pglite", "local-sqlite"],
    guards:
      "a constraint-claim write losing its arbiter-index resolution (falling back to a sequential scan of the uniques relation), an edge-claim batch losing its single-statement Values-Scan shape, or an axis takeover losing its keyed seek.",
    mutation:
      "UNIQUES-ARBITER-SCAN (replacing `buildInsertUniquePostgres`'s `ownerMatches` with a correlated `EXISTS` subquery, `src/backend/drizzle/operations/uniques.ts`) surfaces a `Seq Scan on typegraph_node_uniques` via 3 `InitPlan` subplans; CLAIM-BATCH-FANOUT (forcing `chunkArray`'s batch size to 1 in `operation-backend-core.ts`) turns the batch case's statement count from 1 to 25; CLAIM-TAKEOVER-KEY (dropping `axis`/`key` from `buildTakeOverEdgeClaim`'s UPDATE WHERE, `src/backend/drizzle/operations/edge-claims.ts`) reddens the takeover case. All shown red-then-restored in the commit body.",
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

/**
 * Every `*.test.ts` file under `tests/perf/`, recursing into subdirectories
 * (e.g. `explain/`) — a single-level `readdirSync` would leave every fixture
 * in a subdirectory permanently invisible to {@link PERF_FIXTURES}'s
 * set-equality check, so a whole subdirectory of suites could carry no
 * declared mode, engines, guard or mutation and no test would ever notice.
 * Returns POSIX-style relative paths (`explain/identity-frontier-
 * expansion.test.ts`), matching the `file` field's own convention.
 */
export function scanPerfFixtureFiles(): readonly string[] {
  return walkPerfTestFiles(PERF_DIRECTORY, "").toSorted();
}

function walkPerfTestFiles(
  directory: string,
  relativePrefix: string,
): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath =
      relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      return walkPerfTestFiles(path.join(directory, entry.name), relativePath);
    }
    return entry.name.endsWith(".test.ts") ? [relativePath] : [];
  });
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
