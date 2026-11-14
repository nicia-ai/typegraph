import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

function laneArguments(args: readonly string[]): readonly string[] {
  const directory = mkdtempSync(path.join(tmpdir(), "typegraph-lane-args-"));
  try {
    const executable = path.join(directory, "vitest");
    writeFileSync(executable, '#!/bin/bash\nprintf "%s\\n" "$@"\n');
    chmodSync(executable, 0o755);
    const result = spawnSync(
      "bash",
      [path.join(import.meta.dirname, "../scripts/test-postgres.sh"), ...args],
      {
        cwd: path.join(import.meta.dirname, ".."),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}:${process.env["PATH"] ?? ""}`,
          POSTGRES_URL: "postgresql://argument-test",
          TYPEGRAPH_PG_MAX_WORKERS: "1",
          CI: "",
        },
      },
    );
    expect(result.status).toBe(0);
    return result.stdout.split("\n");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}
describe("PostgreSQL lane argument forwarding", () => {
  it("replaces the full lane with explicitly selected files", () => {
    const file = "tests/backends/postgres/recorded-retention-adoption.test.ts";
    const args = laneArguments([file, "-t", "queued"]);
    expect(args).toContain(file);
    expect(args).not.toContain("tests/backends/postgres/");
    expect(args).not.toContain("tests/graph-merge/");
    expect(args.slice(-4, -1)).toEqual([file, "-t", "queued"]);
  });
  it("keeps the default lane for option-only filters", () => {
    const args = laneArguments([
      "-t",
      "tests/example.test.ts",
      "--exclude",
      "tests/ignored.test.ts",
    ]);
    expect(args).toContain("tests/backends/postgres/");
    expect(args).toContain("tests/graph-merge/");
  });
  it("narrows bare filename filters without expanding the default lane", () => {
    const args = laneArguments(["recorded-retention-adoption"]);
    expect(args).toContain("recorded-retention-adoption");
    expect(args).not.toContain("tests/backends/postgres/");
    expect(args).not.toContain("tests/graph-merge/");
  });
  it.each([
    ["--dir", "tests/backends/postgres"],
    ["--dir=tests/backends/postgres"],
  ])("keeps default roots when --dir is an option value (%j)", (...options) => {
    const args = laneArguments(options);
    expect(args).toContain("tests/backends/postgres/");
    expect(args).toContain("tests/graph-merge/");
  });
});
