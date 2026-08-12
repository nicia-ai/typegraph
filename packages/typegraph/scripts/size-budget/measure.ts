import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

import * as esbuild from "esbuild";

import type { SizeTarget } from "./targets";
import { EXTERNAL_MODULES } from "./targets";

/**
 * `minified`/`gzip` are byte-size claims. `reachedDomains` is a *coupling*
 * claim, not a byte claim: esbuild's metafile `inputs` records the module
 * graph it *parsed* while resolving imports, not the code that survived
 * tree-shaking — a fully tree-shaken module still appears as an input. So
 * "entrypoint X reaches domain Y" means "X's import graph is coupled to Y",
 * never "X's bundle contains code from Y". Byte claims are asserted
 * separately via `minified`/`gzip`; never describe `reachedDomains` as a
 * statement about bundle contents.
 */
export type SizeMeasurement = Readonly<{
  minified: number;
  gzip: number;
  reachedDomains: readonly string[];
}>;

export type ArtifactMeasurement = Readonly<{
  esmBytes: number;
  cjsBytes: number;
  declarationBytes: number;
}>;

/**
 * `external` is deliberately kept out of this `as const` object: `as const`
 * would freeze it into a readonly tuple, which `esbuild.BuildOptions`
 * (mutable `string[]`) rejects. Each call site below spreads this object
 * and then sets `external` itself.
 */
const ESBUILD_BASE_OPTIONS = {
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  minify: true,
  treeShaking: true,
  metafile: true,
  write: false,
  legalComments: "none",
  charset: "utf8",
  sourcemap: false,
  logLevel: "silent",
} as const;

function bundleOptionsFor(target: SizeTarget, packageRoot: string) {
  if (target.kind === "entrypoint") {
    return {
      ...ESBUILD_BASE_OPTIONS,
      absWorkingDir: packageRoot,
      external: [...EXTERNAL_MODULES],
      entryPoints: [target.sourcePath],
    };
  }

  const absoluteSourcePath = path.join(packageRoot, target.sourcePath);
  return {
    ...ESBUILD_BASE_OPTIONS,
    absWorkingDir: packageRoot,
    external: [...EXTERNAL_MODULES],
    stdin: {
      contents: `export { ${target.symbol} } from ${JSON.stringify(absoluteSourcePath)};`,
      resolveDir: packageRoot,
      loader: "ts" as const,
    },
  };
}

/**
 * Maps an esbuild metafile input path to the `src/` domain it belongs to:
 * the first path segment under `src/` for nested modules, `"(root)"` for a
 * file directly under `src/` (e.g. `src/index.ts`), and `undefined` for
 * anything not rooted at `src/` — most notably the synthetic `<stdin>`
 * entry a probe target bundles against.
 */
export function sourceDomain(inputPath: string): string | undefined {
  const normalized = inputPath.replaceAll("\\", "/");
  const match = /^src\/([^/]+)(\/|$)/.exec(normalized);
  if (match === null) {
    return undefined;
  }
  const [, firstSegment, trailingSlashOrEnd] = match;
  return trailingSlashOrEnd === "" ? "(root)" : firstSegment;
}

async function collectFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry): Promise<readonly string[]> => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectFiles(fullPath);
      }
      return [fullPath];
    }),
  );
  return nestedFiles.flat();
}

/**
 * The full inventory of `src/` domains: every directory directly under
 * `src/`, plus `"(root)"` for the files that sit directly under `src/`
 * rather than in a subdirectory. This is the universe `compareExcludedDomains`
 * subtracts a target's reached set from.
 */
export async function listSourceDomains(
  packageRoot: string,
): Promise<readonly string[]> {
  const sourceDirectory = path.join(packageRoot, "src");
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  const domains = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory()) {
      domains.add(entry.name);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      domains.add("(root)");
    }
  }
  return [...domains].toSorted();
}

/**
 * The single owner of bundle measurement: both the vitest suite and the CLI
 * call this, never re-implementing the esbuild invocation. Throws when
 * esbuild reports any warning (a compile-time smell measurement should not
 * silently tolerate) and when the bundle is zero bytes — a mistyped probe
 * symbol produces a silent no-op re-export that esbuild emits no warning
 * for, so an explicit guard is the only thing standing between that typo
 * and a budget entry that always "passes" at 0 bytes.
 */
export async function measureTarget(
  target: SizeTarget,
  packageRoot: string,
): Promise<SizeMeasurement> {
  const result = await esbuild.build(bundleOptionsFor(target, packageRoot));

  if (result.warnings.length > 0) {
    throw new Error(
      `esbuild reported warnings while measuring "${target.id}": ${result.warnings
        .map((warning) => warning.text)
        .join("; ")}`,
    );
  }

  const [outputFile] = result.outputFiles;
  if (outputFile === undefined) {
    throw new Error(
      `esbuild produced no output file while measuring "${target.id}".`,
    );
  }

  const minified = outputFile.contents.byteLength;
  if (minified === 0) {
    throw new Error(
      `Bundle for "${target.id}" is zero bytes. This almost always means a probe symbol does not exist as a runtime value in its entrypoint (a type-only or missing export re-exports to nothing, silently, with no esbuild warning).`,
    );
  }

  const gzip = gzipSync(outputFile.contents, { level: 9 }).byteLength;

  const reachedDomains = [
    ...new Set(
      Object.keys(result.metafile.inputs)
        .map((inputPath) => sourceDomain(inputPath))
        .filter((domain): domain is string => domain !== undefined),
    ),
  ].toSorted();

  return { minified, gzip, reachedDomains };
}

async function sumFileSizes(files: readonly string[]): Promise<number> {
  const sizes = await Promise.all(
    files.map(async (file) => {
      const fileStat = await stat(file);
      return fileStat.size;
    }),
  );
  return sizes.reduce((total, size) => total + size, 0);
}

/**
 * Sums the published `dist/` artifact by kind: ESM (`.js`), CJS (`.cjs`),
 * and type declarations (`.d.ts` + `.d.cts`). Source maps (`*.map`) are
 * excluded — they are never shipped weight from a consumer's perspective in
 * the same sense as the code and types they annotate. Throws — never
 * returns zeros — when `dist` is missing or has no build output, naming
 * the fix (`pnpm build`) so a check that cannot measure fails loudly
 * instead of silently reporting a false "0 bytes, under budget".
 */
export async function measureDistributionArtifacts(
  distributionDirectory: string,
): Promise<ArtifactMeasurement> {
  const directoryExists = await stat(distributionDirectory).then(
    (stats) => stats.isDirectory(),
    () => false,
  );
  if (!directoryExists) {
    throw new Error(
      `dist directory not found at "${distributionDirectory}" — run pnpm build first.`,
    );
  }

  const files = await collectFiles(distributionDirectory);
  const esmFiles = files.filter((file) => file.endsWith(".js"));
  if (esmFiles.length === 0) {
    throw new Error(
      `dist directory at "${distributionDirectory}" contains no .js output — run pnpm build first.`,
    );
  }
  const cjsFiles = files.filter((file) => file.endsWith(".cjs"));
  const declarationFiles = files.filter(
    (file) => file.endsWith(".d.ts") || file.endsWith(".d.cts"),
  );

  const [esmBytes, cjsBytes, declarationBytes] = await Promise.all([
    sumFileSizes(esmFiles),
    sumFileSizes(cjsFiles),
    sumFileSizes(declarationFiles),
  ]);

  return { esmBytes, cjsBytes, declarationBytes };
}
