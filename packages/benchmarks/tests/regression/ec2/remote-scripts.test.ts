import { describe, expect, it } from "vitest";

import {
  REMOTE_NODE_OPTIONS,
  REMOTE_OUTPUT_DIR,
  remoteReportPaths,
  renderFetchCompressedScript,
  renderLaneLogTailScript,
  renderRegressionRunScript,
} from "../../../src/regression/ec2/remote-scripts";

const BASE_OPTIONS = {
  laneIds: undefined,
  baseRef: undefined,
  tagRef: undefined,
  featureBaselineRef: undefined,
  laneTimeoutMs: 900_000,
} as const;

describe("renderRegressionRunScript", () => {
  it("exports the regression heap ceiling", () => {
    const script = renderRegressionRunScript({
      ...BASE_OPTIONS,
      backends: ["sqlite"],
    });
    expect(script).toContain(`export NODE_OPTIONS="${REMOTE_NODE_OPTIONS}"`);
  });

  it("exports POSTGRES_URL only when a postgres leg is requested", () => {
    const sqliteOnly = renderRegressionRunScript({
      ...BASE_OPTIONS,
      backends: ["sqlite"],
    });
    const withPostgres = renderRegressionRunScript({
      ...BASE_OPTIONS,
      backends: ["sqlite", "postgres"],
    });
    expect(sqliteOnly).not.toContain("POSTGRES_URL");
    expect(withPostgres).toContain("export POSTGRES_URL=");
  });

  it("omits undefined baseline flags", () => {
    const script = renderRegressionRunScript({
      ...BASE_OPTIONS,
      backends: ["sqlite"],
    });
    expect(script).not.toContain("--base=");
    expect(script).not.toContain("--tag=");
    expect(script).not.toContain("--feature-baseline=");
    expect(script).not.toContain("--lanes=");
  });

  it("includes defined baseline flags with their exact values", () => {
    const script = renderRegressionRunScript({
      backends: ["sqlite"],
      laneIds: ["perf", "write"],
      baseRef: "main",
      tagRef: "@nicia-ai/typegraph@0.49.0",
      featureBaselineRef: "feature-branch",
      laneTimeoutMs: 900_000,
    });
    expect(script).toContain("--lanes=perf,write");
    expect(script).toContain("--base=main");
    expect(script).toContain("--tag=@nicia-ai/typegraph@0.49.0");
    expect(script).toContain("--feature-baseline=feature-branch");
  });

  it("always emits --backend, --output, and --lane-timeout-ms", () => {
    const script = renderRegressionRunScript({
      ...BASE_OPTIONS,
      backends: ["sqlite", "postgres"],
    });
    expect(script).toContain("--backend=both");
    expect(script).toContain(`--output=${REMOTE_OUTPUT_DIR}`);
    expect(script).toContain("--lane-timeout-ms=900000");
  });
});

describe("remoteReportPaths", () => {
  it("nests per backend only for a multi-backend run", () => {
    const singleBackend = remoteReportPaths(["sqlite"]);
    expect(singleBackend).toEqual([
      {
        backend: "sqlite",
        markdownPath: `${REMOTE_OUTPUT_DIR}/report.md`,
        jsonPath: `${REMOTE_OUTPUT_DIR}/report.json`,
      },
    ]);

    const multiBackend = remoteReportPaths(["sqlite", "postgres"]);
    expect(multiBackend).toEqual([
      {
        backend: "sqlite",
        markdownPath: `${REMOTE_OUTPUT_DIR}/sqlite/report.md`,
        jsonPath: `${REMOTE_OUTPUT_DIR}/sqlite/report.json`,
      },
      {
        backend: "postgres",
        markdownPath: `${REMOTE_OUTPUT_DIR}/postgres/report.md`,
        jsonPath: `${REMOTE_OUTPUT_DIR}/postgres/report.json`,
      },
    ]);
  });
});

describe("renderFetchCompressedScript", () => {
  it("gzips and base64-encodes the remote path", () => {
    const script = renderFetchCompressedScript("/root/report.json");
    expect(script).toBe("gzip -c /root/report.json | base64 -w0");
  });
});

describe("renderLaneLogTailScript", () => {
  it("tails both the regression run log and the per-lane logs", () => {
    const script = renderLaneLogTailScript();
    expect(script).toContain("/var/log/typegraph-regression.log");
    expect(script).toContain(
      "/opt/typegraph/packages/benchmarks/reports/regression/logs/*.log",
    );
  });
});
