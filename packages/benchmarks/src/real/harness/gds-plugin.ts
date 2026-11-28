/**
 * Provisions the pinned Graph Data Science plugin jar for the Neo4j container.
 *
 * The Neo4j image can install GDS itself (`NEO4J_PLUGINS`), but it then picks
 * the build a remote compatibility matrix names at container start, so the
 * plugin version is not part of what the run pinned. Instead the harness
 * downloads the exact release asset once, checks it against the pinned
 * SHA-256, caches it, and copies it into a per-run directory mounted as the
 * container's `/plugins`.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { PINNED_NEO4J_GDS_PLUGIN } from "./engine-pins";

type PluginPin = Readonly<{
  version: string;
  fileName: string;
  url: string;
  sha256: string;
}>;

/** Throws unless `actual` is the pinned digest; never accepts a near miss. */
export function assertPinnedSha256(
  actual: string,
  expected: string,
  source: string,
): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `${source} has SHA-256 ${actual}, expected the pinned ${expected}. ` +
        "Refusing to load an unpinned Graph Data Science build.",
    );
  }
}

async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function pluginCacheDir(): string {
  const cacheRoot = process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache");
  return join(cacheRoot, "typegraph", "neo4j-plugins");
}

/** Returns the cached, digest-checked jar path, downloading it if needed. */
async function ensureCachedJar(
  pin: PluginPin,
  log: (message: string) => void,
): Promise<string> {
  const cacheDir = pluginCacheDir();
  const jarPath = join(cacheDir, pin.fileName);
  if (await fileExists(jarPath)) {
    assertPinnedSha256(await sha256OfFile(jarPath), pin.sha256, jarPath);
    return jarPath;
  }

  await mkdir(cacheDir, { recursive: true });
  log(`downloading Graph Data Science ${pin.version} from ${pin.url}`);
  const response = await fetch(pin.url);
  if (!response.ok) {
    throw new Error(
      `Graph Data Science download failed: ${response.status} ${response.statusText} (${pin.url})`,
    );
  }
  const partialPath = `${jarPath}.partial-${process.pid}`;
  try {
    await writeFile(partialPath, Buffer.from(await response.arrayBuffer()));
    assertPinnedSha256(await sha256OfFile(partialPath), pin.sha256, pin.url);
    await rename(partialPath, jarPath);
  } finally {
    await rm(partialPath, { force: true });
  }
  return jarPath;
}

export type GdsPluginDir = Readonly<{
  /** Host directory to bind-mount as the container's `/plugins`. */
  dir: string;
  version: string;
  sha256: string;
  cleanup(): Promise<void>;
}>;

/**
 * A per-run directory holding only the pinned GDS jar. It lives under the OS
 * temp directory (world-traversable) and is widened to 0755/0644 because the
 * container reads it as its own `neo4j` user, the same reason the import
 * staging directory is widened (see `../engines/neo4j.ts`).
 */
export async function stageGdsPluginDir(
  log: (message: string) => void,
  pin: PluginPin = PINNED_NEO4J_GDS_PLUGIN,
): Promise<GdsPluginDir> {
  const cachedJar = await ensureCachedJar(pin, log);
  const dir = await mkdtemp(
    join(tmpdir(), "typegraph-bench-snb-neo4j-plugins-"),
  );
  try {
    await chmod(dir, 0o755);
    const target = join(dir, pin.fileName);
    await copyFile(cachedJar, target);
    await chmod(target, 0o644);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    dir,
    version: pin.version,
    sha256: pin.sha256,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
