import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The size budget's target inventory. An entrypoint target measures one of
 * the package's 18 published subpaths (`package.json` `exports`); a probe
 * target measures a single named symbol re-exported from an entrypoint, to
 * catch tree-shakeability regressions that a whole-entrypoint budget cannot
 * see (a single heavy import dragged in by an otherwise-small symbol).
 */
export type EntrypointTarget = Readonly<{
  id: string;
  kind: "entrypoint";
  exportPath: string;
  sourcePath: string;
}>;

export type ProbeTarget = Readonly<{
  id: string;
  kind: "probe";
  exportPath: string;
  sourcePath: string;
  symbol: string;
}>;

export type SizeTarget = EntrypointTarget | ProbeTarget;

type PackageExport = Readonly<{ import: string }>;

type PackageManifest = Readonly<{
  dependencies?: Readonly<Record<string, string>>;
  peerDependencies?: Readonly<Record<string, string>>;
  exports: Readonly<Record<string, PackageExport>>;
}>;

/**
 * Modules that cannot be derived from `package.json` `dependencies` /
 * `peerDependencies` because esbuild needs them named individually:
 * `drizzle-orm`'s dialect subpaths (`drizzle-orm/pg-core`, and so on) are
 * imported by path, not by the bare specifier; `sqlite-vec` is loaded via
 * `createRequire` as an optional peer that has no `peerDependencies` entry
 * of its own; and `node:*` covers Node builtins, which are never listed as
 * dependencies.
 */
const LITERAL_EXTERNAL_MODULES = [
  "drizzle-orm/*",
  "sqlite-vec",
  "node:*",
] as const;

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function loadPackageManifestSync(packageRoot: string): PackageManifest {
  const source = readFileSync(path.join(packageRoot, "package.json"), "utf8");
  return JSON.parse(source) as PackageManifest;
}

async function loadPackageManifest(
  packageRoot: string,
): Promise<PackageManifest> {
  const source = await readFile(path.join(packageRoot, "package.json"), "utf8");
  return JSON.parse(source) as PackageManifest;
}

function deriveExternalModules(manifest: PackageManifest): readonly string[] {
  const declaredDependencies = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ];
  return [...declaredDependencies, ...LITERAL_EXTERNAL_MODULES].toSorted();
}

/**
 * All `dependencies` + `peerDependencies` of the package, plus the literal
 * additions above. Every entrypoint and probe bundle is compiled with these
 * marked `external`, so the budget measures only first-party `src/` code —
 * exactly the cost a consumer's own bundler pays after its dependency
 * resolution, not the transitive weight of an optional peer.
 */
export const EXTERNAL_MODULES: readonly string[] = deriveExternalModules(
  loadPackageManifestSync(PACKAGE_ROOT),
);

/**
 * `PROBE_SYMBOLS` names one exported value per probed entrypoint, verified
 * to both exist (see `tests/size-budget-inventory.test.ts`) and to shrink
 * dramatically relative to the whole entrypoint — the point of a probe is
 * to prove that importing one small thing does not drag in the rest of the
 * module graph.
 */
export const PROBE_SYMBOLS: readonly Readonly<{
  exportPath: string;
  symbol: string;
}>[] = [
  { exportPath: ".", symbol: "defineNode" },
  { exportPath: "./core", symbol: "defineNode" },
  { exportPath: "./schema", symbol: "computeSchemaHash" },
  { exportPath: "./indexes", symbol: "generateIndexDDL" },
  { exportPath: "./interchange", symbol: "trustedImportGraph" },
  { exportPath: "./graph-merge", symbol: "planMerge" },
  { exportPath: "./adapters/drizzle/sqlite", symbol: "createSqliteBackend" },
];

/**
 * Maps a package.json `exports[*].import` path (built-artifact space, e.g.
 * `"./dist/core/index.js"`) to the source file esbuild should bundle
 * instead (e.g. `"src/core/index.ts"`). Measurement targets `src/` — see
 * `measure.ts` for why — so every entrypoint needs this translation.
 */
export function sourcePathForExport(distributionImportPath: string): string {
  return distributionImportPath
    .replace(/^\.\/dist\//, "src/")
    .replace(/\.js$/, ".ts");
}

export async function loadEntrypointTargets(
  packageRoot: string,
): Promise<readonly EntrypointTarget[]> {
  const manifest = await loadPackageManifest(packageRoot);
  return Object.entries(manifest.exports)
    .map(([exportPath, exported]): EntrypointTarget => ({
      id: exportPath,
      kind: "entrypoint",
      exportPath,
      sourcePath: sourcePathForExport(exported.import),
    }))
    .toSorted((a, b) => a.exportPath.localeCompare(b.exportPath));
}

export function probeTargetsFor(
  entrypoints: readonly EntrypointTarget[],
): readonly ProbeTarget[] {
  return PROBE_SYMBOLS.map(({ exportPath, symbol }): ProbeTarget => {
    const entrypoint = entrypoints.find(
      (candidate) => candidate.exportPath === exportPath,
    );
    if (entrypoint === undefined) {
      throw new Error(
        `PROBE_SYMBOLS references unknown entrypoint "${exportPath}".`,
      );
    }
    return {
      id: `${exportPath}#${symbol}`,
      kind: "probe",
      exportPath,
      sourcePath: entrypoint.sourcePath,
      symbol,
    };
  });
}
