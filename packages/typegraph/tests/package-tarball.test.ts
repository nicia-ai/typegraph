import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it, onTestFinished } from "vitest";

const PACKAGE_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
const CHANGELOG_PATH = path.join(PACKAGE_DIRECTORY, "CHANGELOG.md");
const CHANGELOG_BUFFER_HEADROOM_BYTES = 1024 * 1024;

it("ships the repository changelog byte-for-byte", () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "typegraph-package-tarball-"),
  );
  onTestFinished(() => {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  });
  const tarballPath = path.join(temporaryDirectory, "typegraph.tgz");

  execFileSync("pnpm", ["pack", "--out", tarballPath], {
    cwd: PACKAGE_DIRECTORY,
    stdio: "pipe",
  });

  const repositoryChangelog = readFileSync(CHANGELOG_PATH);
  const packagedChangelog = execFileSync(
    "tar",
    ["-xOf", tarballPath, "package/CHANGELOG.md"],
    {
      encoding: "buffer",
      maxBuffer:
        repositoryChangelog.byteLength + CHANGELOG_BUFFER_HEADROOM_BYTES,
    },
  );

  expect(packagedChangelog).toEqual(repositoryChangelog);
});
