/**
 * The declaration rollup (`scripts/declaration-rollup.ts`) writes each entry's
 * declaration loads while it generates the bundle, into the build's output
 * directory, in both formats.
 *
 * Runs the rollup over a small emitted-declaration tree rather than the
 * package's, so the watch sequence below can drive many rebuilds quickly; the
 * functions under test are the ones `scripts/build.ts` calls.
 */
import { existsSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RollupWatcher, RollupWatcherEvent } from "rollup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  declarationLoadBlock,
  type PackageExports,
} from "../scripts/declaration-loads";
import {
  buildDeclarations,
  declarationOutDir,
  watchDeclarations,
} from "../scripts/declaration-rollup";

/** Every path the code under test passes to `rm`, in call order. */
const removedPaths = vi.hoisted((): string[] => []);

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      removedPaths.push(String(args[0]));
      await actual.rm(...args);
    },
  };
});

const EXPORTS: PackageExports = {
  ".": { types: "./dist/index.d.ts" },
  "./store": { types: "./dist/store-entry.d.ts" },
  "./sub": { types: "./dist/sub/index.d.ts" },
};

const LOADS: Readonly<Record<string, readonly string[]>> = {
  ".": ["./store", "./sub"],
  "./store": ["."],
  "./sub": ["."],
};

const ENTRY = {
  index: "emit/index.d.ts",
  "store-entry": "emit/store-entry.d.ts",
  "sub/index": "emit/sub/index.d.ts",
} as const;

/** Entry file (relative to the output directory) per export, without extension. */
const ENTRY_FILES = {
  ".": "index",
  "./store": "store-entry",
  "./sub": "sub/index",
} as const;

let packageRoot: string;

async function writeEmitTree(revision: number): Promise<void> {
  await mkdir(path.join(packageRoot, "emit", "sub"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "emit", "shared.d.ts"),
    `export type Shared = { revision: ${revision} };\n`,
  );
  await writeFile(
    path.join(packageRoot, "emit", "index.d.ts"),
    `import type { Shared } from "./shared";\nexport type { Shared };\nexport type Root = { shared: Shared };\n`,
  );
  await writeFile(
    path.join(packageRoot, "emit", "store-entry.d.ts"),
    `import type { Shared } from "./shared";\nexport type Store = { shared: Shared };\n`,
  );
  await writeFile(
    path.join(packageRoot, "emit", "sub", "index.d.ts"),
    `export type Sub = { revision: ${revision} };\n`,
  );
}

beforeEach(async () => {
  packageRoot = await mkdtemp(path.join(tmpdir(), "declaration-rollup-"));
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "fixture", type: "module" })}\n`,
  );
  await writeEmitTree(0);
});

afterEach(async () => {
  await rm(packageRoot, { recursive: true, force: true });
});

async function declarationFiles(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { recursive: true });
  return entries
    .filter((entry) => /\.d\.(?:ts|cts|mts)$/.test(entry))
    .map((entry) => entry.split(path.sep).join("/"))
    .toSorted();
}

/** Each entry file that does not start with its exact load block. */
async function entriesMissingLoads(
  outDir: string,
  extension: string,
): Promise<readonly string[]> {
  const missing: string[] = [];
  for (const [exportPath, file] of Object.entries(ENTRY_FILES)) {
    const block = declarationLoadBlock(EXPORTS, exportPath, extension, LOADS);
    const filePath = path.join(outDir, `${file}${extension}`);
    const source =
      existsSync(filePath) ? await readFile(filePath, "utf8") : undefined;
    if (!source?.startsWith(block)) {
      missing.push(`${file}${extension}`);
    }
  }
  return missing;
}

describe("declaration build", () => {
  it("cleans only declaration files inside the output directory", async () => {
    const outDir = declarationOutDir(packageRoot);
    expect(outDir).toBe(path.join(packageRoot, "dist"));
    // Stale declarations inside the output directory: an earlier build's
    // chunk and a flavour this build does not write.
    await mkdir(path.join(outDir, "old"), { recursive: true });
    const stale = [
      path.join(outDir, "index-0ldHa5h0.d.ts"),
      path.join(outDir, "old", "index.d.mts"),
    ];
    // Declarations outside it, which no clean may touch: a source file, a
    // sibling directory whose name extends the output directory's, the
    // package root itself; and the emitted tree the rollup reads.
    await mkdir(path.join(packageRoot, "src"), { recursive: true });
    await mkdir(path.join(packageRoot, "dist-other"), { recursive: true });
    const outside = [
      path.join(packageRoot, "src", "types.d.ts"),
      path.join(packageRoot, "dist-other", "index.d.ts"),
      path.join(packageRoot, "root.d.ts"),
    ];
    const emitted = path.join(packageRoot, "emit", "shared.d.ts");
    for (const file of [...stale, ...outside]) {
      await writeFile(file, "export {};\n");
    }

    removedPaths.length = 0;
    await buildDeclarations({
      packageRoot,
      exports: EXPORTS,
      entry: ENTRY,
      loads: LOADS,
    });

    for (const file of stale) expect(existsSync(file)).toBe(false);
    for (const file of [...outside, emitted]) {
      expect(existsSync(file)).toBe(true);
    }
    expect(removedPaths.length).toBeGreaterThan(0);
    expect(
      removedPaths.filter(
        (removed) => !removed.startsWith(`${outDir}${path.sep}`),
      ),
    ).toEqual([]);
  });

  it("writes both flavours, each loading its own flavour, by default", async () => {
    const outDir = path.join(packageRoot, "dist");
    await buildDeclarations({
      packageRoot,
      exports: EXPORTS,
      entry: ENTRY,
      loads: LOADS,
    });
    expect(await entriesMissingLoads(outDir, ".d.ts")).toEqual([]);
    expect(await entriesMissingLoads(outDir, ".d.cts")).toEqual([]);
    expect(
      await readFile(path.join(outDir, "store-entry.d.cts"), "utf8"),
    ).toContain('/// <reference path="index.d.cts" />');
  });

  it("fails the build rather than write a reference to a missing entry", async () => {
    await expect(
      buildDeclarations({
        packageRoot,
        exports: EXPORTS,
        entry: { index: ENTRY.index, "store-entry": ENTRY["store-entry"] },
        loads: LOADS,
      }),
    ).rejects.toThrow(/no entry sub\/index\.d\.ts/);
  });
});

describe("declaration watch", () => {
  let watcher: RollupWatcher | undefined;

  afterEach(async () => {
    await watcher?.close();
    watcher = undefined;
  });

  it("keeps every entry carrying its loads, and keeps watching, through a scripted rebuild sequence", async () => {
    const outDir = path.join(packageRoot, "dist");
    const events: RollupWatcherEvent["code"][] = [];
    const errors: string[] = [];
    let completed = 0;
    let closed = false;
    watcher = await watchDeclarations(
      {
        packageRoot,
        exports: EXPORTS,
        entry: ENTRY,
        loads: LOADS,
      },
      (event) => {
        events.push(event.code);
        if (event.code === "ERROR") errors.push(event.error.message);
        if (event.code === "END") completed += 1;
      },
    );
    watcher.on("close", () => {
      closed = true;
    });

    // Every read of an entry file, at any moment of the sequence, must show
    // its loads: a file is never published without them. (An empty read is a
    // write in progress, which begins with the block.)
    const unpatchedReads: string[] = [];
    const observation = { active: true };
    const observer = (async () => {
      while (observation.active) {
        for (const [exportPath, file] of Object.entries(ENTRY_FILES)) {
          for (const extension of [".d.ts", ".d.cts"]) {
            const filePath = path.join(outDir, `${file}${extension}`);
            let source: string;
            try {
              source = await readFile(filePath, "utf8");
            } catch {
              continue;
            }
            const block = declarationLoadBlock(
              EXPORTS,
              exportPath,
              extension,
              LOADS,
            );
            if (
              source !== "" &&
              !source.startsWith(block.slice(0, source.length))
            ) {
              unpatchedReads.push(`${file}${extension}`);
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })();

    async function untilBuilt(after: number): Promise<void> {
      const deadline = Date.now() + 20_000;
      while (completed <= after) {
        if (Date.now() > deadline) {
          throw new Error(`No rebuild completed; events: ${events.join(",")}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // Let a rebuild queued behind this one finish too.
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    await untilBuilt(0);
    expect(await entriesMissingLoads(outDir, ".d.ts")).toEqual([]);

    // 1. An edit to the emitted tree, as `tsc --watch` makes.
    let before = completed;
    await writeEmitTree(1);
    await untilBuilt(before);
    expect(
      await readFile(path.join(outDir, "sub", "index.d.ts"), "utf8"),
    ).toContain("revision: 1");

    // 2. Every declaration file removed between rebuilds, then an edit.
    before = completed;
    for (const file of await declarationFiles(outDir)) {
      await rm(path.join(outDir, file), { force: true });
    }
    await writeEmitTree(2);
    await untilBuilt(before);

    // 3. A burst of edits, as a full recompile writes the tree file by file.
    before = completed;
    for (let revision = 3; revision < 8; revision += 1) {
      await writeEmitTree(revision);
    }
    await untilBuilt(before);
    expect(
      await readFile(path.join(outDir, "sub", "index.d.ts"), "utf8"),
    ).toContain("revision: 7");

    // 4. A broken emit, then a fix: the rebuild fails, the watcher survives.
    before = completed;
    await writeFile(
      path.join(packageRoot, "emit", "store-entry.d.ts"),
      `import type { Shared } from "./missing-module-that-breaks-resolution";\nexport type Store = { shared: Shared; ;\n`,
    );
    const deadline = Date.now() + 20_000;
    while (!events.includes("ERROR") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(errors.length).toBeGreaterThan(0);
    await writeEmitTree(8);
    await untilBuilt(before);

    observation.active = false;
    await observer;

    expect(closed).toBe(false);
    expect(unpatchedReads).toEqual([]);
    expect(await entriesMissingLoads(outDir, ".d.ts")).toEqual([]);
    expect(await entriesMissingLoads(outDir, ".d.cts")).toEqual([]);
    expect(
      await readFile(path.join(outDir, "sub", "index.d.ts"), "utf8"),
    ).toContain("revision: 8");
    // Stale content-hashed chunks from earlier rebuilds do not linger.
    const finalFiles = await declarationFiles(outDir);
    const chunks = finalFiles.filter((file) => /-[\w-]{8}\.d\.ts$/.test(file));
    expect(chunks.length).toBeLessThanOrEqual(1);
  }, 120_000);
});
