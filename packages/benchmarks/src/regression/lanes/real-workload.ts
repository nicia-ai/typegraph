import { type RegressionLane } from "../lanes";

/**
 * Regression lanes backed by the real-workload (LDBC SNB) benchmark
 * program under `src/real/**`. This array is the #286 seam: future SNB
 * lanes (sf1, sf10, additional query mixes) are appended here
 * declaratively as that work lands — no mutable global registry, no
 * runtime `register()` call, no edit anywhere else in the regression
 * harness.
 */
export const REAL_WORKLOAD_LANES: readonly RegressionLane[] = [
  {
    id: "snb-smoke",
    description:
      "LDBC SNB Interactive short-read smoke profile against the bundled fixture dataset.",
    // `bench:snb:smoke` runs every doctor-runnable engine in one invocation
    // (it is not backend-gated the way the synthetic lanes are); there is
    // no separate `:postgres` pnpm script, so the postgres leg is `undefined`.
    scripts: { sqlite: "bench:snb:smoke", postgres: undefined },
    requires: ["snb-dataset"],
  },
];
