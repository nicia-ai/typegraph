import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  extractLaneMeasurements,
  historyFileSize,
  readHistoryTail,
  UnrecognizedHistoryRowError,
} from "../../src/regression/history-extract";

const LATENCIES_LINE = JSON.stringify({
  timestamp: "2026-08-01T00:00:00.000Z",
  gitSha: "abc123",
  gitRefName: "main",
  backend: "sqlite",
  scale: 1,
  userCount: 1200,
  latencies: {
    "forward-traversal": { median: 1.234, p95: 1.5 },
    "inverse traversal (expand: 3-hop)": { median: 2.5, p95: 3.1 },
  },
});

const MEASUREMENTS_LINE = JSON.stringify({
  timestamp: "2026-08-01T00:00:00.000Z",
  gitSha: "abc123",
  gitRefName: "main",
  lane: "identity",
  backend: "sqlite",
  warmupIterations: 2,
  sampleIterations: 7,
  seedRowsPerKind: 100,
  measurements: {
    "identity:store-create": {
      median: 0.0025,
      p95: 0.0026,
      opsPerSample: 1000,
    },
  },
});

const QUERIES_LINE = JSON.stringify({
  timestamp: "2026-08-01T00:00:00.000Z",
  gitSha: "abc123",
  gitRefName: "main",
  lane: "snb",
  engine: "typegraph-sqlite",
  profile: "smoke",
  requestsPerQuery: 15,
  loadMs: 10.1,
  queries: {
    "snb:IS1": {
      medianMs: 12.3,
      p95Ms: 15,
      p99Ms: 16,
      cvPercent: 5,
      noisy: false,
      comparable: true,
    },
  },
});

const SECOND_ENGINE_QUERIES_LINE = JSON.stringify({
  timestamp: "2026-08-01T00:00:01.000Z",
  gitSha: "abc123",
  gitRefName: "main",
  lane: "snb",
  engine: "typegraph-postgres",
  profile: "smoke",
  requestsPerQuery: 15,
  loadMs: 20.2,
  queries: {
    "snb:IS2": {
      medianMs: 30.1,
      p95Ms: 33,
      p99Ms: 35,
      cvPercent: 5,
      noisy: false,
      comparable: true,
    },
  },
});

describe("extractLaneMeasurements", () => {
  it("normalizes the latencies shape", () => {
    const run = extractLaneMeasurements([LATENCIES_LINE]);
    expect(run.measurements.get("forward-traversal")).toBe(1.234);
  });

  it("normalizes the measurements shape", () => {
    const run = extractLaneMeasurements([MEASUREMENTS_LINE]);
    expect(run.measurements.get("identity:store-create")).toBe(0.0025);
  });

  it("normalizes the queries shape", () => {
    const run = extractLaneMeasurements([QUERIES_LINE]);
    expect(run.measurements.get("snb:IS1")).toBe(12.3);
  });

  it("throws on an unrecognized history row", () => {
    const badLine = JSON.stringify({ backend: "sqlite", somethingElse: 1 });
    expect(() => extractLaneMeasurements([badLine])).toThrowError(
      UnrecognizedHistoryRowError,
    );
  });

  it("collects all lines appended during the run, not just the last", () => {
    const run = extractLaneMeasurements([
      QUERIES_LINE,
      SECOND_ENGINE_QUERIES_LINE,
    ]);
    expect(run.measurements.get("snb:IS1")).toBe(12.3);
    expect(run.measurements.get("snb:IS2")).toBe(30.1);
  });

  it("preserves labels containing colons and spaces verbatim", () => {
    const run = extractLaneMeasurements([LATENCIES_LINE]);
    expect(run.measurements.has("inverse traversal (expand: 3-hop)")).toBe(
      true,
    );
  });

  it("captures sampleIterations into the signature", () => {
    const run = extractLaneMeasurements([MEASUREMENTS_LINE]);
    expect(run.signature["sampleIterations"]).toBe(7);
  });

  it("captures the queries shape's comparability-relevant signature fields", () => {
    const run = extractLaneMeasurements([QUERIES_LINE]);
    expect(run.signature["profile"]).toBe("smoke");
    expect(run.signature["requestsPerQuery"]).toBe(15);
  });
});

describe("historyFileSize / readHistoryTail", () => {
  it("reads only the bytes appended after the recorded offset, across multiple lines", () => {
    const scratchDir = mkdtempSync(
      path.join(tmpdir(), "typegraph-history-extract-"),
    );
    const historyPath = path.join(scratchDir, "history.jsonl");
    writeFileSync(historyPath, `${LATENCIES_LINE}\n`, "utf-8");

    const byteOffsetBefore = historyFileSize(historyPath);
    writeFileSync(
      historyPath,
      `${QUERIES_LINE}\n${SECOND_ENGINE_QUERIES_LINE}\n`,
      { flag: "a", encoding: "utf-8" },
    );

    const tail = readHistoryTail(historyPath, byteOffsetBefore);
    expect(tail).toEqual([QUERIES_LINE, SECOND_ENGINE_QUERIES_LINE]);
  });

  it("reports size 0 for a history file that does not exist yet", () => {
    const scratchDir = mkdtempSync(
      path.join(tmpdir(), "typegraph-history-extract-"),
    );
    const historyPath = path.join(scratchDir, "does-not-exist.jsonl");
    expect(historyFileSize(historyPath)).toBe(0);
  });
});
