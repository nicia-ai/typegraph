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
 * declarations name it LOADS that subpath's declarations: the build writes a
 * `/// <reference path>` directive to the subpath's `.d.ts` at the top of the
 * entrypoint's emitted `.d.ts`. The directive brings the subpath into the
 * consumer's program without a runtime import, and TypeScript then names the
 * type through the subpath's public specifier.
 *
 * `tests/public-type-reachability.test.ts` (contract 3) proves this map, with
 * each entrypoint's own exports, names every type the entrypoint's public
 * declarations reference, and that every listed load supplies at least one of
 * them. Loads are transitive: an entrypoint's program also holds whatever the
 * entrypoints it loads load in turn.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** The subpaths that mirror the root's Store surface load the root. */
const LOADS_ROOT = ["."] as const;

export const DECLARATION_LOADS: Readonly<Record<string, readonly string[]>> = {
  ".": [
    "./store",
    "./query",
    "./core",
    "./schema",
    "./identity",
    "./graph-extension",
    "./errors",
    "./indexes",
  ],
  "./store": LOADS_ROOT,
  "./query": LOADS_ROOT,
  "./errors": LOADS_ROOT,
  "./identity": LOADS_ROOT,
  "./maintenance": LOADS_ROOT,
  "./schema": LOADS_ROOT,
  "./graph-merge": LOADS_ROOT,
  "./interchange": LOADS_ROOT,
  "./profiler": LOADS_ROOT,
  "./provenance": LOADS_ROOT,
  "./sqlite/local": LOADS_ROOT,
  "./postgres/pglite": LOADS_ROOT,
  "./core": ["./graph-extension", "./indexes", "./query"],
  "./indexes": ["./core", "./query", "./profiler"],
  "./graph-extension": ["./core", "./errors", "./schema", "./graph-merge"],
  "./adapters/drizzle/sqlite": ["./core", "./indexes", "./query"],
  "./adapters/drizzle/sqlite/local": ["./adapters/drizzle/sqlite"],
  "./adapters/drizzle/sqlite/libsql": ["./adapters/drizzle/sqlite"],
  "./adapters/drizzle/postgres": ["./core", "./indexes", "./query"],
  "./adapters/drizzle/postgres/working-copy": [".", "./graph-merge"],
  "./adapters/drizzle/postgres/pglite": ["./adapters/drizzle/postgres"],
  "./adapters/drizzle/indexes": ["./core", "./indexes", "./query"],
};

type PackageExports = Readonly<
  Record<string, Readonly<{ types: string }> | undefined>
>;

/** The first line of the block the build writes; marks it for replacement. */
const LOAD_BLOCK_MARKER =
  "// Declaration loads (scripts/declaration-loads.ts): name the types this entrypoint's declarations reference through the entrypoints that export them.";

const REFERENCE_DIRECTIVE_PATTERN = /^\/\/\/ <reference path="[^"]*" \/>$/;

/** The two declaration flavours the rollup writes for every entry. */
const DECLARATION_EXTENSIONS = [".d.ts", ".d.cts"] as const;

function typesFileOf(exports: PackageExports, exportPath: string): string {
  const types = exports[exportPath]?.types;
  if (types === undefined) {
    throw new Error(
      `scripts/declaration-loads.ts names ${exportPath}, which package.json exports without a "types" file.`,
    );
  }
  return types;
}

function withExtension(typesFile: string, extension: string): string {
  if (!typesFile.endsWith(".d.ts")) {
    throw new Error(`Entry declarations ${typesFile} do not end with .d.ts.`);
  }
  return `${typesFile.slice(0, -".d.ts".length)}${extension}`;
}

/**
 * The block written at the top of `exportPath`'s declaration file with the
 * given extension: the marker, then one reference per loaded entrypoint, each
 * relative to the declaration file and pointing at the loaded entrypoint's
 * declaration file of the same extension.
 */
export function declarationLoadBlock(
  exports: PackageExports,
  exportPath: string,
  extension: string,
): string {
  const loads = DECLARATION_LOADS[exportPath] ?? [];
  if (loads.length === 0) return "";
  const from = path.posix.dirname(
    withExtension(typesFileOf(exports, exportPath), extension),
  );
  const directives = loads.map((loaded) => {
    const target = withExtension(typesFileOf(exports, loaded), extension);
    return `/// <reference path="${path.posix.relative(from, target)}" />`;
  });
  return `${[LOAD_BLOCK_MARKER, ...directives].join("\n")}\n`;
}

/** A declaration file's text without a block an earlier write left. */
function withoutLoadBlock(source: string): string {
  const lines = source.split("\n");
  if (lines[0] !== LOAD_BLOCK_MARKER) return source;
  let end = 1;
  while (REFERENCE_DIRECTIVE_PATTERN.test(lines[end] ?? "")) end += 1;
  return lines.slice(end).join("\n");
}

/**
 * Writes each entrypoint's load block into its emitted declaration files,
 * replacing any block a previous run wrote. Refuses a load whose target
 * declaration file does not exist: a dangling reference fails every
 * consumer's compilation, `skipLibCheck` or not.
 */
export async function writeDeclarationLoads(
  packageRoot: string,
  exports: PackageExports,
): Promise<void> {
  for (const exportPath of Object.keys(DECLARATION_LOADS)) {
    for (const extension of DECLARATION_EXTENSIONS) {
      const file = path.join(
        packageRoot,
        withExtension(typesFileOf(exports, exportPath), extension),
      );
      const block = declarationLoadBlock(exports, exportPath, extension);
      for (const loaded of DECLARATION_LOADS[exportPath] ?? []) {
        const target = path.join(
          packageRoot,
          withExtension(typesFileOf(exports, loaded), extension),
        );
        if (!existsSync(target)) {
          throw new Error(
            `${path.relative(packageRoot, file)} loads ${loaded}, whose declarations ${path.relative(packageRoot, target)} were not emitted.`,
          );
        }
      }
      const source = await readFile(file, "utf8");
      const next = `${block}${withoutLoadBlock(source)}`;
      if (next !== source) await writeFile(file, next, "utf8");
    }
  }
}

/** Whether `source` starts with exactly the block `declarationLoadBlock` builds. */
export function hasDeclarationLoadBlock(
  source: string,
  exports: PackageExports,
  exportPath: string,
  extension: string,
): boolean {
  const block = declarationLoadBlock(exports, exportPath, extension);
  return block === "" || source.startsWith(block);
}
