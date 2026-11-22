/**
 * The declaration rollup: bundles each entrypoint's `.d.ts` out of the tree
 * `tsc` emitted (`scripts/declaration-emit.ts`), with rollup-plugin-dts, and
 * writes each entry's declaration loads (`scripts/declaration-loads.ts`)
 * into the generated bundle before rollup writes it.
 *
 * tsup used to run this rollup itself (`dts` in `tsup.config.ts`), and the
 * build patched the loads into its output afterwards. tsup cannot run a
 * plugin inside its declaration worker (it drops every function before
 * handing the options over), so the patch had to be a second pass over files
 * tsup owned, which a watch rebuild could clean or rewrite underneath it.
 * Owning the rollup puts the loads inside the step that publishes the files.
 * The configuration reproduces tsup's: the same entries, externals, plugin
 * options, file names and per-format extensions.
 *
 * It writes both formats into the JavaScript build's output directory
 * (`OUT_DIR` in `tsup.config.ts`); the build takes no flag that moves either
 * (`scripts/build-options.ts`).
 */
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  type OutputOptions,
  type Plugin,
  rollup,
  type RollupOptions,
  type RollupWatcher,
  type RollupWatcherEvent,
  watch,
} from "rollup";
import { dts } from "rollup-plugin-dts";

import { DECLARATION_ENTRY, EXTERNAL, OUT_DIR } from "../tsup.config";
import {
  declarationLoadsPlugin,
  type PackageExports,
} from "./declaration-loads";

/** The formats the package builds, with the declaration extension tsup gives each in a `"type": "module"` package. */
const DECLARATION_EXTENSIONS = {
  esm: ".d.ts",
  cjs: ".d.cts",
} as const;

/** The output directory the rollup writes, and cleans, for a package root. */
export function declarationOutDir(packageRoot: string): string {
  return path.join(packageRoot, OUT_DIR);
}

export type DeclarationRollupInput = Readonly<{
  packageRoot: string;
  exports: PackageExports;
  /** Entry name → emitted declaration file; defaults to `tsup.config.ts`'s. */
  entry?: Readonly<Record<string, string>>;
  /** Declaration loads; defaults to `scripts/declaration-loads.ts`'s map. */
  loads?: Readonly<Record<string, readonly string[]>>;
}>;

type PackageManifest = Readonly<{
  dependencies?: Readonly<Record<string, string>>;
  peerDependencies?: Readonly<Record<string, string>>;
}>;

/** tsup's externals: every production dependency and peer, by name or subpath, plus the config's list. */
async function externalsOf(packageRoot: string): Promise<readonly RegExp[]> {
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as PackageManifest;
  const names = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...EXTERNAL,
  ];
  return names.map(
    (name) =>
      new RegExp(
        String.raw`^${name.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}($|\/|\\)`,
      ),
  );
}

/** The rollup configuration: one input graph, one output per format. */
async function declarationRollupOptions(
  input: DeclarationRollupInput,
): Promise<RollupOptions & { output: OutputOptions[] }> {
  const entry = input.entry ?? DECLARATION_ENTRY;
  return {
    input: Object.fromEntries(
      Object.entries(entry).map(([name, file]) => [
        name,
        path.resolve(input.packageRoot, file),
      ]),
    ),
    onwarn(warning, handler) {
      // tsup's filter: bare imports of types the package does not bundle.
      if (
        warning.code === "UNRESOLVED_IMPORT" ||
        warning.code === "CIRCULAR_DEPENDENCY" ||
        warning.code === "EMPTY_BUNDLE"
      ) {
        return;
      }
      handler(warning);
    },
    plugins: [
      dts({
        compilerOptions: {
          declaration: true,
          noEmit: false,
          emitDeclarationOnly: true,
          noEmitOnError: true,
          checkJs: false,
          declarationMap: false,
          skipLibCheck: true,
          preserveSymlinks: false,
        },
      }),
    ],
    external: [...(await externalsOf(input.packageRoot))],
    output: Object.values(DECLARATION_EXTENSIONS).map((extension) => {
      return {
        dir: declarationOutDir(input.packageRoot),
        format: "esm",
        exports: "named",
        entryFileNames: `[name]${extension}`,
        chunkFileNames: `[name]-[hash]${extension}`,
        plugins: [
          pruneStaleDeclarations(extension),
          declarationLoadsPlugin({
            exports: input.exports,
            extension,
            ...(input.loads === undefined ? {} : { loads: input.loads }),
          }),
        ],
      } satisfies OutputOptions;
    }),
  };
}

const DECLARATION_FILE_PATTERN = /\.d\.(?:ts|cts|mts)$/;

async function declarationFilesUnder(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, {
      recursive: true,
      withFileTypes: true,
    });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter(
      (entry) => entry.isFile() && DECLARATION_FILE_PATTERN.test(entry.name),
    )
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * Removes every declaration file under the output directory, as tsup's clean
 * did before its declaration build: a stale chunk or a format this build no
 * longer writes must not survive into the package.
 */
async function removeDeclarationFiles(outDir: string): Promise<void> {
  for (const file of await declarationFilesUnder(outDir)) {
    await rm(file, { force: true });
  }
}

/**
 * After a write, removes the declaration files with this output's extension
 * that the write did not produce: a watch rebuild renames content-hashed
 * chunks, and the previous names must not linger beside the new ones.
 */
function pruneStaleDeclarations(extension: string): Plugin {
  return {
    name: "typegraph:prune-stale-declarations",
    async writeBundle(outputOptions, bundle) {
      const outDir = outputOptions.dir;
      if (outDir === undefined) return;
      const written = new Set(
        Object.keys(bundle).map((fileName) => path.join(outDir, fileName)),
      );
      for (const file of await declarationFilesUnder(outDir)) {
        if (file.endsWith(extension) && !written.has(file)) {
          await rm(file, { force: true });
        }
      }
    },
  };
}

/** Builds and writes the declarations once. */
export async function buildDeclarations(
  input: DeclarationRollupInput,
): Promise<void> {
  const { output, ...options } = await declarationRollupOptions(input);
  await removeDeclarationFiles(declarationOutDir(input.packageRoot));
  const bundle = await rollup(options);
  try {
    for (const outputOptions of output) await bundle.write(outputOptions);
  } finally {
    await bundle.close();
  }
}

/**
 * Watches the emitted declaration tree and rebuilds the declarations on every
 * change, each rebuild writing its files with their loads in place. A failed
 * rebuild is reported to `onEvent` and the watcher keeps running, like
 * `tsc --watch`; the caller closes it.
 */
export async function watchDeclarations(
  input: DeclarationRollupInput,
  onEvent: (event: RollupWatcherEvent) => void,
): Promise<RollupWatcher> {
  const options = await declarationRollupOptions(input);
  await removeDeclarationFiles(declarationOutDir(input.packageRoot));
  const watcher = watch({
    ...options,
    watch: { clearScreen: false, buildDelay: 100 },
  });
  watcher.on("event", (event) => {
    onEvent(event);
    if (event.code === "BUNDLE_END" || event.code === "ERROR") {
      void event.result?.close();
    }
  });
  return watcher;
}
