/**
 * The package build: emit declarations with `tsc`, then run tsup.
 *
 * tsup bundles the JavaScript from `src` and rolls each entrypoint's `.d.ts`
 * out of the declaration tree this script emits first (see
 * `scripts/declaration-emit.ts` for why the rollup no longer derives
 * declarations from source itself). The two stages therefore have a hard
 * order, which is what this script owns.
 *
 * `--watch` keeps both stages live with ONE compile: `tsc --watch` owns the
 * declaration tree, and tsup's rollup watches the files it writes, so a source
 * edit refreshes the bundles and the declarations together. A watch session
 * survives a type error the way `tsc --watch` does — it keeps watching and
 * recovers on the next save — so the one-shot compile, whose non-zero exit is
 * fatal, runs only for a non-watch build. Every argument other than `--watch`
 * is forwarded to tsup unchanged.
 *
 * After tsup writes the entry declarations, this script writes each entry's
 * declaration loads into them (`scripts/declaration-loads.ts`). A watch
 * session re-applies them whenever tsup rewrites an entry's declarations.
 */
import {
  type ChildProcess,
  spawn,
  type SpawnOptions,
} from "node:child_process";
import { access, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  assertNoDeclarationOverride,
  DECLARATION_EMIT_DIR,
  DECLARATION_ENTRY_FILES,
  DECLARATION_HEAP_MB,
  DECLARATION_TSCONFIG,
  PACKAGE_ROOT,
} from "./declaration-emit";
import { writeDeclarationLoads } from "./declaration-loads";

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

function killChildren(): void {
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  children.clear();
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

type PackageManifest = Readonly<{
  exports: Readonly<Record<string, Readonly<{ types: string }>>>;
}>;

async function readPackageExports(): Promise<PackageManifest["exports"]> {
  const manifest = JSON.parse(
    await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
  ) as PackageManifest;
  return manifest.exports;
}

/** How often a watch session checks for entry declarations tsup rewrote. */
const LOADS_POLL_MS = 500;
/** How long an entry's declarations must sit unmodified before a rewrite. */
const LOADS_SETTLE_MS = 1000;

async function newestEntryDeclarationMtime(
  exports: PackageManifest["exports"],
): Promise<number | undefined> {
  let newest = 0;
  for (const exported of Object.values(exports)) {
    for (const file of [
      exported.types,
      exported.types.replace(/\.d\.ts$/, ".d.cts"),
    ]) {
      try {
        newest = Math.max(
          newest,
          (await stat(path.join(PACKAGE_ROOT, file))).mtimeMs,
        );
      } catch {
        // tsup has not (re)written every entry yet.
        return undefined;
      }
    }
  }
  return newest;
}

/**
 * Keeps a watch session's entry declarations carrying their loads: once every
 * entry's declarations exist and none changed for `LOADS_SETTLE_MS` (tsup's
 * rollup finished writing), re-applies the loads. The write is idempotent, so
 * a settled tree that already carries them is left untouched.
 */
function superviseDeclarationLoads(
  exports: PackageManifest["exports"],
): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    let appliedThrough = 0;
    const timer = setInterval(() => {
      void (async () => {
        const newest = await newestEntryDeclarationMtime(exports);
        if (newest === undefined || newest <= appliedThrough) return;
        if (Date.now() - newest < LOADS_SETTLE_MS) return;
        await writeDeclarationLoads(PACKAGE_ROOT, exports);
        appliedThrough =
          (await newestEntryDeclarationMtime(exports)) ?? appliedThrough;
      })().catch((error: unknown) => {
        clearInterval(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    }, LOADS_POLL_MS);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  assertNoDeclarationOverride(args);
  const watch = args.includes(WATCH_FLAG);

  await rm(DECLARATION_EMIT_DIR, { force: true, recursive: true });

  if (!watch) {
    await runToCompletion(
      "Declaration emit (tsc)",
      TSC_BIN,
      declarationEmitArguments(false),
    );
    await runToCompletion("Bundle (tsup)", TSUP_BIN, args);
    await writeDeclarationLoads(PACKAGE_ROOT, await readPackageExports());
    return;
  }

  const watcher = spawnNode(TSC_BIN, declarationEmitArguments(true));
  const watcherClosed = superviseWatcher(watcher);
  await Promise.race([waitForFirstDeclarationEmit(), watcherClosed]);
  await Promise.race([
    runToCompletion("Bundle (tsup)", TSUP_BIN, args),
    watcherClosed,
    superviseDeclarationLoads(await readPackageExports()),
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
