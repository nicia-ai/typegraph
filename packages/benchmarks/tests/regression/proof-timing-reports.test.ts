import path from "node:path";

import { describe, expect, it } from "vitest";

import { timingReportPaths } from "../../src/regression/proof/timing-reports";

describe("timingReportPaths", () => {
  it("reads each backend's nested report for a --backend=both proof", () => {
    expect(timingReportPaths("/tmp/proof", ["sqlite", "postgres"])).toEqual([
      {
        backend: "sqlite",
        reportPath: path.join("/tmp/proof", "sqlite", "report.json"),
      },
      {
        backend: "postgres",
        reportPath: path.join("/tmp/proof", "postgres", "report.json"),
      },
    ]);
  });

  it("reads the root report for a single-backend proof", () => {
    expect(timingReportPaths("/tmp/proof", ["sqlite"])).toEqual([
      {
        backend: "sqlite",
        reportPath: path.join("/tmp/proof", "report.json"),
      },
    ]);
  });
});
