import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { assertPinnedSha256, stageGdsPluginDir } from "./gds-plugin";

const JAR_BYTES = Buffer.from("not really a jar");
const JAR_SHA256 = createHash("sha256").update(JAR_BYTES).digest("hex");
const PIN = {
  version: "0.0.0-test",
  fileName: "gds-test.jar",
  // Never fetched: every case below pre-populates the cache.
  url: "https://invalid.example/gds-test.jar",
  sha256: JAR_SHA256,
} as const;

describe("assertPinnedSha256", () => {
  it("accepts the pinned digest in either case", () => {
    assertPinnedSha256(JAR_SHA256.toUpperCase(), JAR_SHA256, "jar");
  });

  it("refuses any other digest", () => {
    assert.throws(
      () => assertPinnedSha256("0".repeat(64), JAR_SHA256, "jar"),
      /expected the pinned/,
    );
  });
});

describe("stageGdsPluginDir", () => {
  let cacheRoot: string;
  const previousCache = process.env["XDG_CACHE_HOME"];

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "gds-plugin-test-"));
    process.env["XDG_CACHE_HOME"] = cacheRoot;
    await mkdir(join(cacheRoot, "typegraph", "neo4j-plugins"), {
      recursive: true,
    });
  });

  afterEach(async () => {
    if (previousCache === undefined) delete process.env["XDG_CACHE_HOME"];
    else process.env["XDG_CACHE_HOME"] = previousCache;
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("copies a cached jar with the pinned digest into a world-readable plugin dir", async () => {
    await writeFile(
      join(cacheRoot, "typegraph", "neo4j-plugins", PIN.fileName),
      JAR_BYTES,
    );
    const staged = await stageGdsPluginDir(() => undefined, PIN);
    try {
      const jar = join(staged.dir, PIN.fileName);
      assert.equal(statSync(staged.dir).mode & 0o777, 0o755);
      assert.equal(statSync(jar).mode & 0o777, 0o644);
      assert.equal(staged.sha256, JAR_SHA256);
    } finally {
      await staged.cleanup();
    }
    assert.equal(existsSync(staged.dir), false);
  });

  it("refuses a cached jar whose digest is not the pin", async () => {
    await writeFile(
      join(cacheRoot, "typegraph", "neo4j-plugins", PIN.fileName),
      Buffer.from("tampered"),
    );
    await assert.rejects(
      stageGdsPluginDir(() => undefined, PIN),
      /expected the pinned/,
    );
  });
});
