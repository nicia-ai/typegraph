import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const PACKAGE_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
const CHANGELOG_PATH = path.join(PACKAGE_DIRECTORY, "CHANGELOG.md");

describe("published package", () => {
  let temporaryDirectory: string | undefined;

  afterEach(() => {
    if (temporaryDirectory !== undefined) {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("ships the repository changelog byte-for-byte", () => {
    temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "typegraph-package-tarball-"),
    );
    const tarballPath = path.join(temporaryDirectory, "typegraph.tgz");

    execFileSync("pnpm", ["pack", "--out", tarballPath], {
      cwd: PACKAGE_DIRECTORY,
      stdio: "pipe",
    });

    const packagedChangelog = execFileSync(
      "tar",
      ["-xOf", tarballPath, "package/CHANGELOG.md"],
      { encoding: "buffer" },
    );

    expect(packagedChangelog).toEqual(readFileSync(CHANGELOG_PATH));
  });
});
