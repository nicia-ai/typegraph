import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { type RegressionReport } from "../../src/regression/compare";
import { DEFAULT_REGRESSION_POLICY } from "../../src/regression/policy";
import {
  renderMarkdownReport,
  writeRegressionReport,
} from "../../src/regression/report";

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
