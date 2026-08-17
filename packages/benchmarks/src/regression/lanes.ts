import { REAL_WORKLOAD_LANES } from "./lanes/real-workload";
import { SYNTHETIC_LANES } from "./lanes/synthetic";
import { type MeasurementSemantics } from "./policy";

export type LaneBackend = "sqlite" | "postgres";

type LaneRequirement = "postgres-url" | "snb-dataset" | "sqlite-vec";

export type RegressionLane = Readonly<{
  id: string;
  description: string;
  /** pnpm script name in packages/benchmarks per backend; undefined = lane has no leg there. */
  scripts: Readonly<Record<LaneBackend, string | undefined>>;
  requires?: readonly LaneRequirement[];
  /** Exact-label overrides for metrics whose unit or polarity is not latency. */
  measurementSemantics?: Readonly<Record<string, MeasurementSemantics>>;
}>;

/**
 * The full lane registry: existing synthetic suites plus the real-workload
 * (#286) lanes. Composition, not a mutable registry — a future lane is
 * appended to `SYNTHETIC_LANES` or `REAL_WORKLOAD_LANES`, never registered
 * at runtime.
 */
export const REGRESSION_LANES: readonly RegressionLane[] = [
  ...SYNTHETIC_LANES,
  ...REAL_WORKLOAD_LANES,
];

class DuplicateLaneIdError extends Error {
  constructor(laneId: string) {
    super(`Duplicate regression lane id: "${laneId}".`);
    this.name = "DuplicateLaneIdError";
  }
}

export function assertUniqueLaneIds(lanes: readonly RegressionLane[]): void {
  const seen = new Set<string>();
  for (const lane of lanes) {
    if (seen.has(lane.id)) {
      throw new DuplicateLaneIdError(lane.id);
    }
    seen.add(lane.id);
  }
}

// Fail fast at module load: a duplicate lane id in the registry is a
// programming error, not a runtime condition to discover mid-run.
assertUniqueLaneIds(REGRESSION_LANES);

const DEFAULT_LANE_IDS: readonly string[] = ["perf", "write", "identity"];

class UnknownLaneIdError extends Error {
  constructor(laneId: string, validIds: readonly string[]) {
    super(
      `Unknown regression lane id: "${laneId}". Valid ids: ${validIds.join(", ")}.`,
    );
    this.name = "UnknownLaneIdError";
  }
}

/**
 * Resolves requested lane ids to their `RegressionLane` definitions.
 * `undefined` resolves to the default set (`perf`, `write`, `identity`).
 * An unknown id throws, naming every valid id.
 */
export function resolveLanes(
  ids: readonly string[] | undefined,
): readonly RegressionLane[] {
  const requestedIds = ids ?? DEFAULT_LANE_IDS;
  const validIds = REGRESSION_LANES.map((lane) => lane.id);
  return requestedIds.map((id) => {
    const lane = REGRESSION_LANES.find((candidate) => candidate.id === id);
    if (lane === undefined) {
      throw new UnknownLaneIdError(id, validIds);
    }
    return lane;
  });
}
