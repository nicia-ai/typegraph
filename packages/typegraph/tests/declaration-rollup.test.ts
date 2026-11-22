/**
 * The declaration rollup (`scripts/declaration-rollup.ts`) writes each entry's
 * declaration loads while it generates the bundle, into the output directory
 * and formats the build invocation gives tsup.
 *
 * Runs the rollup over a small emitted-declaration tree rather than the
 * package's, so the watch sequence below can drive many rebuilds quickly; the
 * functions under test are the ones `scripts/build.ts` calls.
 */
import { existsSync } from "node:fs";
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  declarationLoadBlock,
  type PackageExports,
} from "../scripts/declaration-loads";
import {
  buildDeclarations,
  declarationBuildOf,
  watchDeclarations,
} from "../scripts/declaration-rollup";

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

describe("declaration build options", () => {
  it("follows tsup's defaults and its --out-dir / --format spellings", () => {
    const root = "/package";
    expect(declarationBuildOf(["--silent"], root)).toEqual({
      outDir: "/package/dist",
      formats: ["esm", "cjs"],
    });
    for (const args of [
      ["--out-dir", "custom"],
      ["--out-dir=custom"],
      ["-d", "custom"],
    ]) {
      expect(declarationBuildOf(args, root).outDir).toBe("/package/custom");
    }
    expect(declarationBuildOf(["--format", "esm"], root).formats).toEqual([
      "esm",
    ]);
    expect(declarationBuildOf(["--format=cjs"], root).formats).toEqual(["cjs"]);
    expect(
      declarationBuildOf(["--format", "esm", "--format", "cjs"], root).formats,
    ).toEqual(["esm", "cjs"]);
    expect(declarationBuildOf(["--format", "cjs,esm"], root).formats).toEqual([
      "cjs",
      "esm",
    ]);
    expect(
      declarationBuildOf(["--watch", "--minify", "--target", "es2022"], root),
    ).toEqual({ outDir: "/package/dist", formats: ["esm", "cjs"] });
  });

  it("refuses a flag whose effect on tsup's output it cannot mirror", () => {
    const root = "/package";
    expect(() => declarationBuildOf(["--format", "iife"], root)).toThrow(
      /--format iife is not built here/,
    );
    for (const flag of [
      "--legacy-output",
      "--entry.main=src/index.ts",
      "--config=other.ts",
      "--no-config",
      "--cjsInterop",
    ]) {
      expect(() => declarationBuildOf([flag], root)).toThrow(
        /cannot be passed to the build/,
      );
    }
    for (const outDir of [".", "src", "src/x", "node_modules/x", ".."]) {
      expect(() => declarationBuildOf(["--out-dir", outDir], root)).toThrow(
        /would be emptied by the build/,
      );
    }
  });
});

describe("declaration build", () => {
  it("writes the formats an invocation asks for into its output directory, with their loads", async () => {
    const outDir = path.join(packageRoot, "custom");
    await mkdir(outDir, { recursive: true });
    // A stale flavour from an earlier build must not survive.
    await writeFile(path.join(outDir, "index.d.cts"), "stale\n");

    await buildDeclarations({
      packageRoot,
      build: declarationBuildOf(
        ["--out-dir", "custom", "--format", "esm"],
        packageRoot,
      ),
      exports: EXPORTS,
      entry: ENTRY,
      loads: LOADS,
    });

    const written = await declarationFiles(outDir);
    expect(written).toContain("index.d.ts");
    expect(written).toContain("store-entry.d.ts");
    expect(written).toContain("sub/index.d.ts");
    expect(written.filter((file) => !file.endsWith(".d.ts"))).toEqual([]);
    expect(await entriesMissingLoads(outDir, ".d.ts")).toEqual([]);
    expect(
      await readFile(path.join(outDir, "sub", "index.d.ts"), "utf8"),
    ).toMatch(
      /^\/\/ Declaration loads[^\n]*\n\/\/\/ <reference path="\.\.\/index\.d\.ts" \/>\n/,
    );
    // The manifest's directory is not written to.
    expect(await declarationFiles(path.join(packageRoot, "dist"))).toEqual([]);
  });

  it("writes both flavours, each loading its own flavour, by default", async () => {
    const outDir = path.join(packageRoot, "dist");
    await buildDeclarations({
      packageRoot,
      build: declarationBuildOf([], packageRoot),
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
        build: declarationBuildOf(["--format", "esm"], packageRoot),
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
        build: declarationBuildOf([], packageRoot),
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
