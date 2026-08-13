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

const WORKFLOW_PATH = fileURLToPath(
  new URL("../../../.github/workflows/ci.yml", import.meta.url),
);
const RELEASE_WORKFLOW_PATH = fileURLToPath(
  new URL("../../../.github/workflows/release.yml", import.meta.url),
);
const METADATA_PREDICATE_PATH = fileURLToPath(
  new URL(
    "../../../.github/scripts/is-release-metadata-only.sh",
    import.meta.url,
  ),
);
const TSUP_CONFIG_PATH = fileURLToPath(
  new URL("../tsup.config.ts", import.meta.url),
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

function classifyCommitRange(
  fixtureDirectory: string,
  baseSha: string,
  headSha: string,
): string {
  return execFileSync(METADATA_PREDICATE_PATH, [baseSha, headSha], {
    cwd: fixtureDirectory,
    encoding: "utf8",
  }).trim();
}

describe("CI workflow contract", () => {
  let fixtureDirectory: string;

  beforeEach(() => {
    fixtureDirectory = mkdtempSync(
      path.join(tmpdir(), "typegraph-ci-contract-"),
    );
    runGit(fixtureDirectory, ["init"]);
    runGit(fixtureDirectory, ["config", "user.name", "CI Contract Test"]);
    runGit(fixtureDirectory, [
      "config",
      "user.email",
      "ci-contract@example.com",
    ]);
    writeFixtureFile(
      fixtureDirectory,
      "packages/typegraph/package.json",
      `${JSON.stringify({ name: "typegraph", scripts: { test: "vitest" }, version: "1.0.0" }, undefined, 2)}\n`,
    );
    writeFixtureFile(
      fixtureDirectory,
      "packages/typegraph/CHANGELOG.md",
      "# Changelog\n",
    );
    commitFixture(fixtureDirectory, "initial fixture");
  });

  afterEach(() => {
    rmSync(fixtureDirectory, { force: true, recursive: true });
  });

  it("runs four coverage shards with timeout headroom", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    for (const [index, shard] of ["1/4", "2/4", "3/4", "4/4"].entries()) {
      expect(workflow).toContain(`shard: "${shard}"`);
      expect(workflow).toContain(`artifact: coverage-blob-${index + 1}`);
    }

    expect(workflow).toMatch(
      /test-coverage:[\s\S]*?timeout-minutes: 30[\s\S]*?strategy:/,
    );
  });

  it("gives CI and release declaration builds enough worker heap", () => {
    for (const workflowPath of [WORKFLOW_PATH, RELEASE_WORKFLOW_PATH]) {
      expect(readFileSync(workflowPath, "utf8")).toContain(
        "NODE_OPTIONS: --max-old-space-size=6144",
      );
    }
  });

  it("detects metadata-only changes on pushes and pull requests", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const baseSha = runGit(fixtureDirectory, ["rev-parse", "HEAD"]);

    expect(workflow).toContain('base_sha="${{ github.event.before }}"');
    expect(workflow).toContain('head_sha="${{ github.sha }}"');
    expect(workflow).toContain("github.event.pull_request.base.sha");
    expect(workflow).toContain("github.event.pull_request.head.sha");
    expect(workflow).toContain(
      'if [[ "$base_sha" == "0000000000000000000000000000000000000000" ]]',
    );
    expect(workflow).toContain('echo "skip_heavy_ci=false"');
    expect(workflow).toContain("skip_heavy_ci");

    writeFixtureFile(
      fixtureDirectory,
      ".changeset/release.md",
      '---\n"typegraph": patch\n---\n',
    );
    const changesetSha = commitFixture(fixtureDirectory, "add changeset");
    expect(classifyCommitRange(fixtureDirectory, baseSha, changesetSha)).toBe(
      "true",
    );

    writeFixtureFile(fixtureDirectory, "CHANGELOG.md", "# Workspace changes\n");
    const rootChangelogSha = commitFixture(
      fixtureDirectory,
      "update root changelog",
    );
    expect(
      classifyCommitRange(fixtureDirectory, changesetSha, rootChangelogSha),
    ).toBe("true");

    writeFixtureFile(
      fixtureDirectory,
      "packages/typegraph/package.json",
      `${JSON.stringify({ name: "typegraph", scripts: { test: "vitest" }, version: "1.0.1" }, undefined, 2)}\n`,
    );
    writeFixtureFile(
      fixtureDirectory,
      "packages/typegraph/CHANGELOG.md",
      "# Changelog\n\n## 1.0.1\n",
    );
    const metadataSha = commitFixture(fixtureDirectory, "release metadata");

    expect(
      classifyCommitRange(fixtureDirectory, rootChangelogSha, metadataSha),
    ).toBe("true");

    writeFixtureFile(
      fixtureDirectory,
      "packages/typegraph/package.json",
      `${JSON.stringify({ name: "typegraph", scripts: { test: "vitest --run" }, version: "1.0.2" }, undefined, 2)}\n`,
    );
    const scriptChangeSha = commitFixture(
      fixtureDirectory,
      "change package script",
    );
    expect(
      classifyCommitRange(fixtureDirectory, metadataSha, scriptChangeSha),
    ).toBe("false");

    writeFixtureFile(
      fixtureDirectory,
      "packages/typegraph/src/index.ts",
      "export const changed = true;\n",
    );
    const sourceChangeSha = commitFixture(fixtureDirectory, "change source");
    expect(
      classifyCommitRange(fixtureDirectory, scriptChangeSha, sourceChangeSha),
    ).toBe("false");
    expect(
      classifyCommitRange(fixtureDirectory, sourceChangeSha, sourceChangeSha),
    ).toBe("false");

    writeFixtureFile(
      fixtureDirectory,
      "packages/typegraph/package.json",
      "{ invalid json\n",
    );
    const invalidPackageSha = commitFixture(
      fixtureDirectory,
      "malform package manifest",
    );
    expect(
      classifyCommitRange(fixtureDirectory, sourceChangeSha, invalidPackageSha),
    ).toBe("false");

    writeFixtureFile(
      fixtureDirectory,
      "packages/typegraph/package.json",
      `${JSON.stringify({ name: "typegraph", scripts: { test: "vitest --run" }, version: "1.0.3" }, undefined, 2)}\n`,
    );
    const restoredPackageSha = commitFixture(
      fixtureDirectory,
      "restore package manifest",
    );
    expect(
      classifyCommitRange(
        fixtureDirectory,
        invalidPackageSha,
        restoredPackageSha,
      ),
    ).toBe("false");
  });

  it("rejects invalid metadata predicate invocations", () => {
    const result = spawnSync(METADATA_PREDICATE_PATH, [], {
      cwd: fixtureDirectory,
      encoding: "utf8",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  it("builds in parallel and preserves Build as the final required gate", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    expect(workflow).toMatch(
      /build-artifacts:[\s\S]*?needs: \[detect-release-metadata-push\][\s\S]*?pnpm turbo run build/,
    );
    expect(workflow).toMatch(
      /\n {2}build:\n[\s\S]*?name: Build[\s\S]*?- build-artifacts[\s\S]*?toJSON\(needs\)/,
    );
    for (const requiredJob of [
      "build-artifacts",
      "lint-and-check",
      "test-sqlite-unit",
      "test-sqlite-property",
      "test-sqlite-smoke",
      "test-strict-local-consumers",
      "test-coverage-merge",
      "test-typescript-compat",
      "test-postgres",
      "test-durable-objects",
    ]) {
      expect(workflow).toMatch(
        new RegExp(String.raw`\n {6}- ${requiredJob}(?:\n|$)`),
      );
    }
    expect(workflow).toContain('.value.result != "success"');
    expect(workflow).toContain("!cancelled()");
  });

  it("pins tsup splitting:true, which the missing-peer refusal depends on in both formats", () => {
    // `./sqlite/local` and `./postgres/pglite` defer their `drizzle-orm`
    // resolution behind `await import("./*-store-impl")` so a missing peer
    // surfaces as a typed refusal instead of a bare module-resolution stack
    // (design §4.4b). That mechanism depends on `splitting: true`: measured
    // against `tsup@8.5.1`, `splitting: false` hoists the impl module's
    // `drizzle-orm` import to the ENTRY's top level in both the ESM and CJS
    // artifacts, so `require(entryPath)`/`import(entryPath)` fails
    // synchronously before the factory function is ever called — the
    // factory's own `catch` (inside `loadDrizzleBackedModule`) never runs,
    // in either format. `tests/drizzle-reachability.test.ts`'s dist-grain
    // suite measures the same dependency directly (T17/M10).
    const tsupConfig = readFileSync(TSUP_CONFIG_PATH, "utf8");
    expect(tsupConfig).toContain("splitting: true");
  });
});
