import path from "node:path";

import { type LaneBackend } from "../lanes";
import { resolveBackendReportDir } from "../report";

/** Report files emitted by one proof timing run, in requested backend order. */
export function timingReportPaths(
  outputDir: string,
  backends: readonly LaneBackend[],
): readonly Readonly<{ backend: LaneBackend; reportPath: string }>[] {
  return backends.map((backend) => ({
    backend,
    reportPath: path.join(
      resolveBackendReportDir(outputDir, backends.length, backend),
      "report.json",
    ),
  }));
}
