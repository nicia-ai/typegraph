import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { type RegressionReport } from "../../src/regression/compare";
import {
  REMOTE_OUTPUT_DIR,
  remoteReportPaths,
} from "../../src/regression/ec2/remote-scripts";
import { DEFAULT_REGRESSION_POLICY } from "../../src/regression/policy";
import {
  renderMarkdownReport,
  resolveBackendReportDir,
  writeFetchedBackendReport,
  writeRegressionReport,
} from "../../src/regression/report";

function freshOutputDir(): string {
  return mkdtempSync(path.join(tmpdir(), "typegraph-regression-report-"));
}

function buildReport(): RegressionReport {
  return {
    generatedAt: "2026-08-12T00:00:00.000Z",
    candidate: { ref: "HEAD", sha: "cand1234567", path: "/tmp/candidate" },
    baselines: [
      { id: "tag", ref: "@nicia-ai/typegraph@0.49.0", sha: "tagsha1234567" },
      { id: "base", ref: "main", sha: "basesha1234567" },
    ],
    backends: ["sqlite"],
    policy: DEFAULT_REGRESSION_POLICY,
    lanes: [
      {
        kind: "compared",
        laneId: "perf",
        baseline: "tag",
        comparisons: [
          {
            laneId: "perf",
            label: "forward-traversal",
            baseline: "tag",
            baselineMs: 100,
            candidateMs: 130,
            ratio: 1.3,
            deltaMs: 30,
            classification: "accepted",
            note: "known slow leg pending #123",
          },
        ],
      },
      {
        kind: "compared",
        laneId: "perf",
        baseline: "base",
        comparisons: [
          {
            laneId: "perf",
            label: "forward-traversal",
            baseline: "base",
            baselineMs: 100,
            candidateMs: 105,
            ratio: 1.05,
            deltaMs: 5,
            classification: "ok",
          },
        ],
      },
    ],
    staleAcceptances: [],
    hardFailures: [],
    flags: [],
  };
}

describe("renderMarkdownReport", () => {
  it("markdown includes every worktree SHA", () => {
    const report = buildReport();
    const markdown = renderMarkdownReport(report);
    expect(markdown).toContain(report.candidate.sha);
    for (const baseline of report.baselines) {
      expect(markdown).toContain(baseline.sha);
    }
  });

  it("markdown lists each applied acceptance with its reason", () => {
    const report = buildReport();
    const markdown = renderMarkdownReport(report);
    expect(markdown).toContain("Applied acceptances");
    expect(markdown).toContain("known slow leg pending #123");
  });

  it("markdown says none applied when no acceptance was used", () => {
    const report: RegressionReport = {
      ...buildReport(),
      lanes: [
        {
          kind: "compared",
          laneId: "perf",
          baseline: "base",
          comparisons: [
            {
              laneId: "perf",
              label: "forward-traversal",
              baseline: "base",
              baselineMs: 100,
              candidateMs: 105,
              ratio: 1.05,
              deltaMs: 5,
              classification: "ok",
            },
          ],
        },
      ],
    };
    const markdown = renderMarkdownReport(report);
    expect(markdown).toContain("None.");
  });
});

describe("writeRegressionReport", () => {
  it("JSON report nests measurements under their lane id", async () => {
    const report = buildReport();
    const outputDir = mkdtempSync(
      path.join(tmpdir(), "typegraph-regression-report-"),
    );
    const { jsonPath } = await writeRegressionReport(outputDir, report);
    const parsed = JSON.parse(readFileSync(jsonPath, "utf-8")) as Readonly<{
      lanes: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    }>;
    expect(parsed.lanes["perf"]).toBeDefined();
    expect(parsed.lanes["perf"]?.["tag"]).toBeDefined();
    expect(parsed.lanes["perf"]?.["base"]).toBeDefined();
    // No flattened "perf:tag" string join anywhere in the lane keys.
    expect(Object.keys(parsed.lanes)).not.toContain("perf:tag");
  });

  it("writes both markdown and json to the output directory", async () => {
    const report = buildReport();
    const outputDir = mkdtempSync(
      path.join(tmpdir(), "typegraph-regression-report-"),
    );
    const { markdownPath, jsonPath } = await writeRegressionReport(
      outputDir,
      report,
    );
    expect(readFileSync(markdownPath, "utf-8")).toContain(
      "# Performance regression report",
    );
    expect(readFileSync(jsonPath, "utf-8")).toContain('"generatedAt"');
  });
});

describe("resolveBackendReportDir", () => {
  it("writes directly to outputDir for a single-backend run", () => {
    expect(resolveBackendReportDir("/tmp/out", 1, "sqlite")).toBe("/tmp/out");
  });

  it("nests under a per-backend subdirectory only for a multi-backend run", () => {
    expect(resolveBackendReportDir("/tmp/out", 2, "sqlite")).toBe(
      path.join("/tmp/out", "sqlite"),
    );
    expect(resolveBackendReportDir("/tmp/out", 2, "postgres")).toBe(
      path.join("/tmp/out", "postgres"),
    );
  });

  it("falls back to 'unknown' for a multi-backend run with no backend", () => {
    expect(resolveBackendReportDir("/tmp/out", 2, undefined)).toBe(
      path.join("/tmp/out", "unknown"),
    );
  });
});

describe("writeFetchedBackendReport", () => {
  it("writes flat report files for a single-backend run", async () => {
    const outputDir = freshOutputDir();
    const { markdownPath, jsonPath } = await writeFetchedBackendReport(
      outputDir,
      1,
      "sqlite",
      "# markdown",
      "{}",
    );
    expect(markdownPath).toBe(path.join(outputDir, "report.md"));
    expect(jsonPath).toBe(path.join(outputDir, "report.json"));
    expect(readFileSync(markdownPath, "utf-8")).toBe("# markdown");
    expect(readFileSync(jsonPath, "utf-8")).toBe("{}");
  });

  it("nests report files under a per-backend subdirectory for a multi-backend run", async () => {
    const outputDir = freshOutputDir();
    const { markdownPath, jsonPath } = await writeFetchedBackendReport(
      outputDir,
      2,
      "postgres",
      "# markdown",
      "{}",
    );
    expect(markdownPath).toBe(path.join(outputDir, "postgres", "report.md"));
    expect(jsonPath).toBe(path.join(outputDir, "postgres", "report.json"));
  });

  it("matches remoteReportPaths' layout for every backend count, so the EC2 collector's fetched local copy can never land in a different directory shape than the remote report it was fetched from", async () => {
    for (const backends of [["sqlite"], ["sqlite", "postgres"]] as const) {
      const outputDir = freshOutputDir();
      for (const remote of remoteReportPaths(backends)) {
        const { markdownPath, jsonPath } = await writeFetchedBackendReport(
          outputDir,
          backends.length,
          remote.backend,
          "# markdown",
          "{}",
        );
        expect(path.relative(outputDir, markdownPath)).toBe(
          path.posix.relative(REMOTE_OUTPUT_DIR, remote.markdownPath),
        );
        expect(path.relative(outputDir, jsonPath)).toBe(
          path.posix.relative(REMOTE_OUTPUT_DIR, remote.jsonPath),
        );
      }
    }
  });
});
