/**
 * Which entrypoints' declarations each entrypoint's declarations load.
 *
 * Declaration emit can spell a type only through a module already in the
 * consumer's program. A consumer that imports one entrypoint and exports the
 * inferred type of something it returns (a graph, a store, a query) makes
 * TypeScript name every type that inferred type is spelled with; a type that
 * entrypoint does not export itself is otherwise reachable only through a
 * content-hashed `dist` chunk, which is not portable (TS2742 / TS2883).
 *
 * The root and the subpaths that mirror its Store surface name hundreds of
 * such types. Rather than re-export every one from every entrypoint that
 * names it, each type is exported once, from the subpath that owns its
 * concept (`/store`, `/query`, `/core`, ...), and an entrypoint whose
 * declarations name it LOADS that subpath's declarations: the declaration
 * rollup (`scripts/declaration-rollup.ts`) writes a `/// <reference path>`
 * directive to the subpath's `.d.ts` at the top of the entrypoint's `.d.ts`
 * while it generates the bundle, before anything is written. The directive
 * brings the subpath into the consumer's program without a runtime import,
 * and TypeScript then names the type through the subpath's public specifier.
 *
 * The map is a star through the root: the root loads each subpath that
 * exports a name some covered entrypoint needs, and every other entrypoint
 * loads the root, except the adapters' runtime-specific variants
 * (`/adapters/drizzle/sqlite/local`, `/adapters/drizzle/sqlite/libsql`,
 * `/adapters/drizzle/postgres/pglite`), which load nothing: the only types
 * they reference from elsewhere are reached through their adapter's
 * `SqliteTables` / `PostgresTables`, aliases of `ReturnType<typeof …>` that
 * declaration emit always spells out, never names. An entrypoint with no
 * entry here gets no load block. `tests/public-type-reachability.test.ts` (contract 3) proves
 * that, with each entrypoint's own exports, this map names every type the
 * entrypoint's public declarations reference, and that removing any one load
 * leaves some entrypoint unable to name a type it needs. Loads are
 * transitive: an entrypoint's program also holds whatever the entrypoints it
 * loads load in turn.
 */
import path from "node:path";

import type { NormalizedOutputOptions, OutputBundle, Plugin } from "rollup";

const LOADS_ROOT = ["."] as const;

export const DECLARATION_LOADS: Readonly<Record<string, readonly string[]>> = {
  ".": [
    "./store",
    "./query",
    "./errors",
    "./identity",
    "./core",
    "./schema",
    "./indexes",
    "./graph-extension",
    "./graph-merge",
    "./profiler",
  ],
  "./store": LOADS_ROOT,
  "./query": LOADS_ROOT,
  "./errors": LOADS_ROOT,
  "./identity": LOADS_ROOT,
  "./maintenance": LOADS_ROOT,
  "./core": LOADS_ROOT,
  "./schema": LOADS_ROOT,
  "./indexes": LOADS_ROOT,
  "./graph-extension": LOADS_ROOT,
  "./graph-merge": LOADS_ROOT,
  "./interchange": LOADS_ROOT,
  "./profiler": LOADS_ROOT,
  "./provenance": LOADS_ROOT,
  "./sqlite/local": LOADS_ROOT,
  "./postgres/pglite": LOADS_ROOT,
  "./adapters/drizzle/sqlite": LOADS_ROOT,
  "./adapters/drizzle/postgres": LOADS_ROOT,
  "./adapters/drizzle/postgres/working-copy": LOADS_ROOT,
  "./adapters/drizzle/indexes": LOADS_ROOT,
};

export type PackageExports = Readonly<
  Record<string, Readonly<{ types: string }> | undefined>
>;

/**
 * Where `package.json` says the declarations live: the build's output
 * directory (`OUT_DIR` in `tsup.config.ts`). Every `types` path is under it,
 * and each load is written relative to it.
 */
const MANIFEST_OUT_DIR = "./dist/";

/** The first line of the block the rollup writes. */
const LOAD_BLOCK_MARKER =
  "// Declaration loads (scripts/declaration-loads.ts): name the types this entrypoint's declarations reference through the entrypoints that export them.";

/**
 * `exportPath`'s declaration file with `extension`, relative to the output
 * directory: `./store` → `store-entry.d.ts` (or `store-entry.d.cts`).
 */
function declarationFileOf(
  exports: PackageExports,
  exportPath: string,
  extension: string,
): string {
  const types = exports[exportPath]?.types;
  if (types === undefined) {
    throw new Error(
      `scripts/declaration-loads.ts names ${exportPath}, which package.json exports without a "types" file.`,
    );
  }
  if (!types.startsWith(MANIFEST_OUT_DIR) || !types.endsWith(".d.ts")) {
    throw new Error(
      `package.json exports ${exportPath} with types ${types}, which is not a ${MANIFEST_OUT_DIR}….d.ts file.`,
    );
  }
  return `${types.slice(MANIFEST_OUT_DIR.length, -".d.ts".length)}${extension}`;
}

/**
 * The block written at the top of `exportPath`'s declaration file with the
 * given extension: the marker, then one reference per loaded entrypoint, each
 * relative to the declaration file and pointing at the loaded entrypoint's
 * declaration file of the same extension. Empty for an entrypoint that loads
 * nothing.
 */
export function declarationLoadBlock(
  exports: PackageExports,
  exportPath: string,
  extension: string,
  loads: Readonly<Record<string, readonly string[]>> = DECLARATION_LOADS,
): string {
  const loaded = loads[exportPath] ?? [];
  if (loaded.length === 0) return "";
  const from = path.posix.dirname(
    declarationFileOf(exports, exportPath, extension),
  );
  const directives = loaded.map((target) => {
    const targetFile = declarationFileOf(exports, target, extension);
    return `/// <reference path="${path.posix.relative(from, targetFile)}" />`;
  });
  return `${[LOAD_BLOCK_MARKER, ...directives].join("\n")}\n`;
}

/**
 * Whether `source` carries exactly the loads `declarationLoadBlock` builds:
 * it starts with the block, and no reference directive follows it. An
 * entrypoint that loads nothing therefore carries none.
 */
export function hasDeclarationLoadBlock(
  source: string,
  exports: PackageExports,
  exportPath: string,
  extension: string,
): boolean {
  const block = declarationLoadBlock(exports, exportPath, extension);
  if (!source.startsWith(block)) return false;
  const rest = source.slice(block.length);
  return (
    !rest.includes(LOAD_BLOCK_MARKER) && !/^\/\/\/ <reference path=/m.test(rest)
  );
}

/**
 * Writes each entrypoint's load block into its entry chunk while rollup
 * generates the bundle, so the declaration files are written with their
 * loads already in place: no pass after the write, and nothing for a later
 * rebuild or clean to race. Fails the build (a watch session reports the
 * error and keeps watching) when an entrypoint the map names, or one it
 * loads, is not an entry chunk of this output: a dangling reference fails
 * every consumer's compilation, `skipLibCheck` or not.
 */
export function declarationLoadsPlugin(
  options: Readonly<{
    exports: PackageExports;
    extension: string;
    loads?: Readonly<Record<string, readonly string[]>>;
  }>,
): Plugin {
  const loads = options.loads ?? DECLARATION_LOADS;
  return {
    name: "typegraph:declaration-loads",
    generateBundle(
      _outputOptions: NormalizedOutputOptions,
      bundle: OutputBundle,
    ) {
      const entryChunk = (exportPath: string) => {
        const fileName = declarationFileOf(
          options.exports,
          exportPath,
          options.extension,
        );
        const output = bundle[fileName];
        if (output?.type !== "chunk" || !output.isEntry) {
          this.error(
            `Declaration loads name ${exportPath}, but this declaration build has no entry ${fileName}.`,
          );
        }
        return output;
      };
      for (const exportPath of Object.keys(loads)) {
        const chunk = entryChunk(exportPath);
        for (const loaded of loads[exportPath] ?? []) entryChunk(loaded);
        const block = declarationLoadBlock(
          options.exports,
          exportPath,
          options.extension,
          loads,
        );
        chunk.code = `${block}${chunk.code}`;
      }
    },
  };
}
