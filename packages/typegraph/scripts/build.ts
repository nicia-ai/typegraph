/**
 * The package build: emit declarations with `tsc`, bundle the JavaScript with
 * tsup, and roll each entrypoint's `.d.ts` out of the emitted tree with the
 * declaration rollup (`scripts/declaration-rollup.ts`).
 *
 * The rollup reads the declaration tree this script emits first (see
 * `scripts/declaration-emit.ts` for why it no longer derives declarations
 * from source itself), and writes each entry's declaration loads
 * (`scripts/declaration-loads.ts`) while it generates the bundle, so every
 * declaration file is written complete. tsup writes no declarations.
 *
 * `--watch` keeps every stage live with ONE compile: `tsc --watch` owns the
 * declaration tree, the declaration rollup watches the files it writes, and
 * tsup watches the sources, so a source edit refreshes the bundles and the
 * declarations together. A watch session survives a type error the way
 * `tsc --watch` does — it keeps watching and recovers on the next save — so
 * the one-shot compile, whose non-zero exit is fatal, runs only for a
 * non-watch build; a failed declaration rebuild is reported and the rollup
 * keeps watching too. Every argument other than `--watch` is forwarded to
 * tsup unchanged, and the declaration rollup writes to the output directory
 * and formats those arguments give tsup.
 */
import {
  type ChildProcess,
  spawn,
  type SpawnOptions,
} from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  assertNoDeclarationOverride,
  DECLARATION_EMIT_DIR,
  DECLARATION_ENTRY_FILES,
  DECLARATION_HEAP_MB,
  DECLARATION_TSCONFIG,
  PACKAGE_ROOT,
} from "./declaration-emit";
import type { PackageExports } from "./declaration-loads";
import {
  buildDeclarations,
  type DeclarationBuild,
  declarationBuildOf,
  watchDeclarations,
} from "./declaration-rollup";

const WATCH_FLAG = "--watch";

const TSC_BIN = path.join(PACKAGE_ROOT, "node_modules/typescript/lib/tsc.js");
const TSUP_BIN = path.join(
  PACKAGE_ROOT,
  "node_modules/tsup/dist/cli-default.js",
);
const HEAP_ARGUMENT = `--max-old-space-size=${DECLARATION_HEAP_MB}`;

/** How long a watch session waits for `tsc --watch`'s first declaration emit. */
const FIRST_EMIT_TIMEOUT_MS = 300_000;
const FIRST_EMIT_POLL_MS = 100;

const SPAWN_OPTIONS: SpawnOptions = {
  cwd: PACKAGE_ROOT,
  stdio: "inherit",
};

const children = new Set<ChildProcess>();
let shuttingDown = false;

function spawnNode(scriptPath: string, args: readonly string[]): ChildProcess {
  const child = spawn(
    process.execPath,
    [HEAP_ARGUMENT, scriptPath, ...args],
    SPAWN_OPTIONS,
  );
  children.add(child);
  child.on("close", () => children.delete(child));
  return child;
}

/** In-process watchers to close on shutdown, like the child processes. */
const closers = new Set<() => void>();

function killChildren(): void {
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  children.clear();
  for (const close of closers) close();
  closers.clear();
}

function whenClosed(child: ChildProcess): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (exitCode) => {
      resolve(exitCode ?? 1);
    });
  });
}

async function runToCompletion(
  label: string,
  scriptPath: string,
  args: readonly string[],
): Promise<void> {
  const code = await whenClosed(spawnNode(scriptPath, args));
  if (code !== 0) {
    throw new Error(`${label} failed with exit code ${code}.`);
  }
}

function declarationEmitArguments(watch: boolean): readonly string[] {
  return [
    "--project",
    DECLARATION_TSCONFIG,
    ...(watch ? ["--watch", "--preserveWatchOutput"] : []),
  ];
}

/**
 * Rejects if the declaration watcher ever closes. A watcher that exits has
 * stopped refreshing the tree tsup rolls, so the session would silently serve
 * declarations frozen at the last emit; fail the pipeline instead. Stays
 * pending through a deliberate shutdown, where the exit is expected.
 */
function superviseWatcher(child: ChildProcess): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      // A shutdown killed it on purpose: stay pending and let the exit path run.
      if (shuttingDown) return;
      reject(
        new Error(
          `Declaration watcher (tsc --watch) closed with exit code ${code ?? 1}; declarations would stop refreshing.`,
        ),
      );
    });
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves once every declaration entry tsup rolls exists, so the rollup's
 * first pass can resolve its inputs. The emit directory is removed before the
 * watcher starts, so presence means this session's watcher wrote them — and
 * `tsc --watch` writes declarations even for a source tree with type errors,
 * which is what lets a watch session start on one and recover.
 */
async function waitForFirstDeclarationEmit(): Promise<void> {
  const deadline = Date.now() + FIRST_EMIT_TIMEOUT_MS;
  for (;;) {
    const present = await Promise.all(
      DECLARATION_ENTRY_FILES.map((filePath) => fileExists(filePath)),
    );
    if (present.every(Boolean)) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Declaration watcher wrote no complete declaration tree within ${FIRST_EMIT_TIMEOUT_MS / 1000}s.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, FIRST_EMIT_POLL_MS));
  }
}

async function readPackageExports(): Promise<PackageExports> {
  const manifest = JSON.parse(
    await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
  ) as Readonly<{ exports: PackageExports }>;
  return manifest.exports;
}

/**
 * Runs the declaration rollup in watch mode for the session. Rejects only if
 * the rollup watcher closes on its own; a failed rebuild is logged and the
 * watcher keeps going, recovering on the next declaration emit.
 */
async function superviseDeclarationRollup(
  build: DeclarationBuild,
): Promise<never> {
  const watcher = await watchDeclarations(
    { packageRoot: PACKAGE_ROOT, build, exports: await readPackageExports() },
    (event) => {
      if (event.code === "BUNDLE_END") {
        console.log(
          `Declarations rolled into ${path.relative(PACKAGE_ROOT, build.outDir) || "."} in ${event.duration}ms`,
        );
      } else if (event.code === "ERROR") {
        console.error(
          `Declaration rollup failed; still watching: ${event.error.message}`,
        );
      }
    },
  );
  closers.add(() => {
    void watcher.close();
  });
  return await new Promise<never>((_resolve, reject) => {
    watcher.on("close", () => {
      if (shuttingDown) return;
      reject(
        new Error(
          "Declaration rollup watcher closed; declarations would stop refreshing.",
        ),
      );
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  assertNoDeclarationOverride(args);
  const watch = args.includes(WATCH_FLAG);
  const build = declarationBuildOf(args, PACKAGE_ROOT);

  await rm(DECLARATION_EMIT_DIR, { force: true, recursive: true });

  if (!watch) {
    await runToCompletion(
      "Declaration emit (tsc)",
      TSC_BIN,
      declarationEmitArguments(false),
    );
    await runToCompletion("Bundle (tsup)", TSUP_BIN, args);
    await buildDeclarations({
      packageRoot: PACKAGE_ROOT,
      build,
      exports: await readPackageExports(),
    });
    return;
  }

  const watcher = spawnNode(TSC_BIN, declarationEmitArguments(true));
  const watcherClosed = superviseWatcher(watcher);
  await Promise.race([waitForFirstDeclarationEmit(), watcherClosed]);
  await Promise.race([
    runToCompletion("Bundle (tsup)", TSUP_BIN, args),
    watcherClosed,
    superviseDeclarationRollup(build),
  ]);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    killChildren();
    process.exit(0);
  });
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  killChildren();
  process.exit(1);
} finally {
  killChildren();
}
