import path from "node:path";

import { describe, expect, it } from "vitest";

import { laneLogPath } from "../../src/regression/run-lane";

describe("laneLogPath", () => {
  it("includes the worktree id, lane id, and backend in the filename", () => {
    expect(
      laneLogPath(
        "/tmp/logs",
        { id: "candidate" },
        { id: "identity" },
        "postgres",
      ),
    ).toBe(path.join("/tmp/logs", "candidate-identity-postgres.log"));
  });

  it("gives the sqlite and postgres runs of the same lane distinct log files", () => {
    // A `--backend=both` invocation (regression-bench.ts's main()) runs the
    // same lane, in the same worktree, once per backend. If the log path
    // didn't vary by backend, the second backend's run would silently
    // overwrite the first's log file.
    const sqlitePath = laneLogPath(
      "/tmp/logs",
      { id: "base" },
      { id: "perf" },
      "sqlite",
    );
    const postgresPath = laneLogPath(
      "/tmp/logs",
      { id: "base" },
      { id: "perf" },
      "postgres",
    );

    expect(sqlitePath).not.toBe(postgresPath);
  });
});
