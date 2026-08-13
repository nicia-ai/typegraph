import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CI_WORKFLOW_PATH = fileURLToPath(
  new URL("../../../.github/workflows/ci.yml", import.meta.url),
);
const PERF_TIMING_LANE_WORKFLOW_PATH = fileURLToPath(
  new URL("../../../.github/workflows/perf-timing-lane.yml", import.meta.url),
);
const ADVISORY_SCRIPT_PATH = fileURLToPath(
  new URL("../../../.github/scripts/perf-lane-advisory.sh", import.meta.url),
);

function runGit(fixtureDirectory: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: fixtureDirectory,
    encoding: "utf8",
  }).trim();
}

function writeFixtureFile(
  fixtureDirectory: string,
  relativePath: string,
  content: string,
): void {
  const absolutePath = path.join(fixtureDirectory, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function commitFixture(fixtureDirectory: string, message: string): string {
  runGit(fixtureDirectory, ["add", "."]);
  runGit(fixtureDirectory, ["commit", "-m", message]);
  return runGit(fixtureDirectory, ["rev-parse", "HEAD"]);
}

function appendLines(
  fixtureDirectory: string,
  relativePath: string,
  count: number,
  prefix: string,
): void {
  const absolutePath = path.join(fixtureDirectory, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  const lines = Array.from(
    { length: count },
    (_unused, index) => `${prefix}${index}`,
  ).join("\n");
  writeFileSync(absolutePath, `${lines}\n`, { flag: "a" });
}

function runAdvisory(
  fixtureDirectory: string,
  baseSha: string,
  headSha: string,
  labelsCsv: string,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    ADVISORY_SCRIPT_PATH,
    [baseSha, headSha, labelsCsv],
    { cwd: fixtureDirectory, encoding: "utf8" },
  );
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr,
    status: result.status,
  };
}

describe("Perf timing lane workflow contract", () => {
  it("triggers on dispatch, weekly schedule, and the perf-lane label", () => {
    const workflow = readFileSync(PERF_TIMING_LANE_WORKFLOW_PATH, "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toMatch(/schedule:\s*\n\s*- cron: "17 7 \* \* 1"/);
    expect(workflow).toMatch(/pull_request:\s*\n\s*types: \[labeled\]/);
  });

  it("is not a required CI gate", () => {
    const ciWorkflow = readFileSync(CI_WORKFLOW_PATH, "utf8");
    expect(ciWorkflow).not.toContain("perf-timing-lane");
    const buildNeedsBlock = /\n {2}build:\n[\s\S]*?toJSON\(needs\)/.exec(
      ciWorkflow,
    )?.[0];
    expect(buildNeedsBlock).toBeDefined();
    expect(buildNeedsBlock).not.toContain("perf-lane-advisory");
  });

  it("keeps PR label text and SHAs out of the perf-lane-advisory run: shell (shell-injection hardening)", () => {
    const ciWorkflow = readFileSync(CI_WORKFLOW_PATH, "utf8");
    const stepStart = ciWorkflow.indexOf(
      "Determine perf-lane advisory verdict",
    );
    expect(stepStart).toBeGreaterThan(-1);
    const stepEnd = ciWorkflow.indexOf("\n\n", stepStart);
    const step = ciWorkflow.slice(
      stepStart,
      stepEnd === -1 ? undefined : stepEnd,
    );

    // A label containing a single quote breaks out of the `'...'`-quoted
    // `${{ }}` substitution this step used before being fixed; every
    // attacker-influenced value must cross into the shell through env:,
    // never interpolated directly into the run: script.
    expect(step).toContain(
      "LABELS_JSON: ${{ toJSON(github.event.pull_request.labels.*.name) }}",
    );
    expect(step).toContain(
      "BASE_SHA: ${{ github.event.pull_request.base.sha }}",
    );
    expect(step).toContain(
      "HEAD_SHA: ${{ github.event.pull_request.head.sha }}",
    );

    const runIndex = step.indexOf("run: |");
    expect(runIndex).toBeGreaterThan(-1);
    const runBody = step.slice(runIndex);
    expect(runBody).not.toContain("${{");
    expect(runBody).toContain('"$LABELS_JSON"');
    expect(runBody).toContain('"$BASE_SHA"');
    expect(runBody).toContain('"$HEAD_SHA"');
  });

  it("never cancels a run holding a live instance", () => {
    const workflow = readFileSync(PERF_TIMING_LANE_WORKFLOW_PATH, "utf8");
    expect(workflow).toMatch(/group: perf-timing-lane/);
    expect(workflow).toContain("cancel-in-progress: false");
  });

  it("always terminates its instance", () => {
    const workflow = readFileSync(PERF_TIMING_LANE_WORKFLOW_PATH, "utf8");
    expect(workflow).toMatch(
      /Terminate the EC2 instance[\s\S]*?if: always\(\)[\s\S]*?terminate-instances/,
    );
  });

  it("refuses a perf-lane label from a fork PR", () => {
    const workflow = readFileSync(PERF_TIMING_LANE_WORKFLOW_PATH, "utf8");
    expect(workflow).toContain("refuse-fork-label");
    expect(workflow).toContain(
      "github.event.pull_request.head.repo.full_name != github.repository",
    );
  });

  it("keeps workflow_dispatch inputs out of the Launch/Collect run: shell", () => {
    const workflow = readFileSync(PERF_TIMING_LANE_WORKFLOW_PATH, "utf8");

    for (const stepName of [
      "Launch regression EC2 lane",
      "Collect regression EC2 lane",
    ]) {
      const stepStart = workflow.indexOf(stepName);
      expect(stepStart).toBeGreaterThan(-1);
      const nextStepIndex = workflow.indexOf(
        "\n      - name:",
        stepStart + stepName.length,
      );
      const step = workflow.slice(
        stepStart,
        nextStepIndex === -1 ? undefined : nextStepIndex,
      );

      const runIndex = step.indexOf("run: |");
      expect(runIndex).toBeGreaterThan(-1);
      const runBody = step.slice(runIndex);
      expect(runBody).not.toContain("${{ github.event.inputs");
    }
  });
});

describe("Perf lane advisory predicate", () => {
  let fixtureDirectory: string;

  beforeEach(() => {
    fixtureDirectory = mkdtempSync(
      path.join(tmpdir(), "typegraph-perf-lane-advisory-"),
    );
    runGit(fixtureDirectory, ["init"]);
    runGit(fixtureDirectory, ["config", "user.name", "Perf Lane Test"]);
    runGit(fixtureDirectory, ["config", "user.email", "perf-lane@example.com"]);
    writeFixtureFile(
      fixtureDirectory,
      "packages/typegraph/src/store/placeholder.ts",
      "export const placeholder = true;\n",
    );
    commitFixture(fixtureDirectory, "initial fixture");
  });

  afterEach(() => {
    rmSync(fixtureDirectory, { force: true, recursive: true });
  });

  it("is mandatory above the changed-line threshold", () => {
    const baseSha = runGit(fixtureDirectory, ["rev-parse", "HEAD"]);
    appendLines(
      fixtureDirectory,
      "packages/typegraph/src/store/placeholder.ts",
      250,
      "line",
    );
    const headSha = commitFixture(fixtureDirectory, "large store change");

    const result = runAdvisory(fixtureDirectory, baseSha, headSha, "");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("mandatory");
  });

  it("is optional for a small change with no label", () => {
    const baseSha = runGit(fixtureDirectory, ["rev-parse", "HEAD"]);
    appendLines(
      fixtureDirectory,
      "packages/typegraph/src/store/placeholder.ts",
      30,
      "line",
    );
    const headSha = commitFixture(fixtureDirectory, "small store change");

    const result = runAdvisory(fixtureDirectory, baseSha, headSha, "");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("optional");
  });

  it("a major-feature label makes the lane mandatory regardless of size", () => {
    const baseSha = runGit(fixtureDirectory, ["rev-parse", "HEAD"]);
    appendLines(
      fixtureDirectory,
      "packages/typegraph/src/store/placeholder.ts",
      2,
      "line",
    );
    const headSha = commitFixture(fixtureDirectory, "tiny store change");

    const result = runAdvisory(
      fixtureDirectory,
      baseSha,
      headSha,
      "major-feature",
    );
    expect(result.stdout).toBe("mandatory");
  });

  it("a refactor or perf-lane label also makes the lane mandatory", () => {
    const baseSha = runGit(fixtureDirectory, ["rev-parse", "HEAD"]);
    appendLines(
      fixtureDirectory,
      "packages/typegraph/src/store/placeholder.ts",
      2,
      "line",
    );
    const headSha = commitFixture(fixtureDirectory, "tiny store change");

    expect(
      runAdvisory(fixtureDirectory, baseSha, headSha, "refactor").stdout,
    ).toBe("mandatory");
    expect(
      runAdvisory(fixtureDirectory, baseSha, headSha, "perf-lane").stdout,
    ).toBe("mandatory");
    expect(
      runAdvisory(fixtureDirectory, baseSha, headSha, "documentation,perf-lane")
        .stdout,
    ).toBe("mandatory");
  });

  it("counts only the PR's own diff, not an upstream commit added to base after branching (two-dot vs three-dot)", () => {
    const defaultBranch = runGit(fixtureDirectory, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);

    runGit(fixtureDirectory, ["checkout", "-b", "feature"]);
    appendLines(
      fixtureDirectory,
      "packages/typegraph/src/store/placeholder.ts",
      30,
      "line",
    );
    const headSha = commitFixture(fixtureDirectory, "small feature change");

    runGit(fixtureDirectory, ["checkout", defaultBranch]);
    appendLines(
      fixtureDirectory,
      "packages/typegraph/src/store/upstream-large.ts",
      300,
      "line",
    );
    const baseSha = commitFixture(
      fixtureDirectory,
      "unrelated upstream change landed on base after the PR branched",
    );

    // A two-dot `git diff base head` compares the two trees directly, so it
    // would also count the 300 lines base gained after branching (as a
    // deletion, from head's point of view) toward the threshold — flagging
    // a 30-line PR as mandatory. The three-dot, merge-base-relative diff
    // isolates just the PR's own 30-line change.
    const result = runAdvisory(fixtureDirectory, baseSha, headSha, "");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("optional");
  });

  it("ignores changes outside query/store/backend", () => {
    const baseSha = runGit(fixtureDirectory, ["rev-parse", "HEAD"]);
    appendLines(
      fixtureDirectory,
      "packages/typegraph/tests/big.test.ts",
      300,
      "line",
    );
    const headSha = commitFixture(fixtureDirectory, "large unrelated change");

    const result = runAdvisory(fixtureDirectory, baseSha, headSha, "");
    expect(result.stdout).toBe("optional");
  });

  it("rejects invalid advisory invocations", () => {
    const oneArgument = spawnSync(ADVISORY_SCRIPT_PATH, ["only-one-arg"], {
      cwd: fixtureDirectory,
      encoding: "utf8",
    });
    expect(oneArgument.status).toBe(2);
    expect(oneArgument.stderr).toContain("Usage:");

    // Exactly two args (the labels argument missing) is refused too — a
    // permissive arity check that lets the third argument silently default
    // to "" would treat "no labels supplied" identically to "labels
    // argument omitted entirely", which is not the same failure mode.
    const twoArguments = spawnSync(
      ADVISORY_SCRIPT_PATH,
      ["deadbeef", "cafebabe"],
      {
        cwd: fixtureDirectory,
        encoding: "utf8",
      },
    );
    expect(twoArguments.status).toBe(2);
    expect(twoArguments.stderr).toContain("Usage:");
  });
});
