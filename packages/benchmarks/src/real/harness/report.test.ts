import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderSnbReport, reportVerdict, type SnbReportInput } from "./report";
import { computeLatencyStats } from "./stats";

const STATS = computeLatencyStats([1, 2, 3]);

function input(overrides: Partial<SnbReportInput> = {}): SnbReportInput {
  return {
    profile: "smoke",
    generatedAt: "2026-11-20T00:00:00.000Z",
    typegraphVersion: "0.75.0",
    gitSha: "abc123",
    gitRefName: "bench/branch",
    datasetRoot: "/fixtures/smoke",
    requestsPerQuery: 15,
    warmupRequests: 3,
    seed: 42,
    host: "test host",
    command: "tsx src/real/snb-short-reads.ts --profile=smoke",
    skippedEngines: [],
    engines: [
      {
        name: "neo4j",
        versions: [
          {
            component: "Neo4j",
            version: "2026.10.2",
            detail: "edition=community",
          },
          { component: "Neo4j Graph Data Science", version: "2026.10.2" },
        ],
        target: "existing server bolt://h:7687, database neo4j",
        loadPath: "online batched UNWIND (10000 rows per transaction)",
        loadMs: 1500,
        unsupported: { IC14: "no weight" },
      },
      {
        name: "pggraph",
        versions: [{ component: "pgGraph", version: "1.2.1" }],
        target: "container ghcr.io/x/pggraph:1.2.1@sha256:abc",
        loadPath: "batched multi-row INSERT, then graph.build()",
        loadMs: 2500,
        unsupported: {},
      },
    ],
    failures: [],
    queries: [
      {
        queryId: "IS1",
        results: [
          { engine: "neo4j", stats: STATS },
          { engine: "pggraph", stats: STATS },
        ],
        comparable: true,
        parityReason: undefined,
      },
      {
        queryId: "IC14",
        results: [{ engine: "pggraph", stats: STATS }],
        comparable: false,
        parityReason: "fewer than 2 engines",
      },
    ],
    ...overrides,
  };
}

describe("reportVerdict", () => {
  it("is OK when every query two or more engines ran agrees", () => {
    assert.equal(reportVerdict(input()), "parity OK across 2 engines");
  });

  it("names mismatched queries, failed engines and engines the doctor skipped", () => {
    const failing = input({
      queries: [
        {
          queryId: "IS2",
          results: [
            { engine: "neo4j", stats: STATS },
            { engine: "pggraph", stats: STATS },
          ],
          comparable: false,
          parityReason: "digest mismatch",
        },
      ],
      failures: [{ engine: "neo4j", error: "boom" }],
      skippedEngines: ["ladybugdb"],
    });
    assert.equal(
      reportVerdict(failing),
      "parity FAILED on IS2; engine failures: neo4j; not run (doctor): ladybugdb",
    );
  });
});

describe("renderSnbReport", () => {
  it("records the versions, target and load path of every engine", () => {
    const report = renderSnbReport(input());
    assert.match(
      report,
      /\| neo4j \| Neo4j 2026\.10\.2 \(edition=community\); Neo4j Graph Data Science 2026\.10\.2 \| existing server bolt:\/\/h:7687, database neo4j \| online batched UNWIND \(10000 rows per transaction\) \| 1500 ms \|/,
    );
    assert.match(report, /\| pggraph \| pgGraph 1\.2\.1 \|/);
    assert.match(report, /TypeGraph: 0\.75\.0 at `abc123` \(bench\/branch\)/);
  });

  it("marks a query a single engine ran as not a parity failure, and shows declared gaps", () => {
    const report = renderSnbReport(input());
    assert.match(report, /\| IC14 \| 1 \| only one engine ran it \|/);
    assert.match(report, /\| IC14 \| unsupported \| 2\.00 \/ /);
    assert.match(report, /- neo4j \/ IC14: no weight/);
  });

  it("escapes table cell pipes", () => {
    const report = renderSnbReport(
      input({
        engines: [
          { ...input().engines[0]!, target: "a|b" },
          input().engines[1]!,
        ],
      }),
    );
    assert.match(report, /a\\\|b/);
  });
});
