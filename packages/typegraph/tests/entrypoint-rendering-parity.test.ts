/**
 * I10 baseline ratchet — the entrypoint list has three hand-maintained
 * renderings (`package.json#exports`, `tsconfig.json#compilerOptions.paths`,
 * `vitest.config.ts#resolve.alias`) that already disagree. This records
 * today's measured gap as executable data rather than a hand count: 18 / 14
 * / 13 keys, with the four missing `tsconfig` entries and the five missing
 * `vitest` entries (the same four, plus `./provenance`) asserted both
 * directions against the derived gap, and every PRESENT rendering checked
 * against the source root {@link sourceRootForEntrypoint} derives, so a
 * silent divergence between "what tsconfig points at" and "what the tsup
 * entry map says" is caught here too.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { sourceRootForEntrypoint } from "../scripts/drizzle-reachability-scan";

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const ALIAS_PREFIX = "@nicia-ai/typegraph";

/** Maps `@nicia-ai/typegraph` -> `.` and `@nicia-ai/typegraph/x` -> `./x`. */
function toExportKey(aliasKey: string): string {
  return aliasKey === ALIAS_PREFIX ? "." : (
      `.${aliasKey.slice(ALIAS_PREFIX.length)}`
    );
}

function readPackageExportKeys(): readonly string[] {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
  ) as Readonly<{ exports: Readonly<Record<string, unknown>> }>;
  return Object.keys(packageJson.exports);
}

type TsconfigShape = Readonly<{
  compilerOptions: Readonly<{
    paths: Readonly<Record<string, readonly string[]>>;
  }>;
}>;

function readTsconfig(): TsconfigShape {
  // A comment in tsconfig.json would make JSON.parse throw; that failure is
  // acceptable, and the try/catch below names the file so it fails loudly
  // rather than silently.
  try {
    return JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, "tsconfig.json"), "utf8"),
    ) as TsconfigShape;
  } catch (error) {
    throw new Error(
      `Failed to JSON.parse tsconfig.json (a comment would cause exactly this)`,
      { cause: error },
    );
  }
}

function readTsconfigAliasKeys(): readonly string[] {
  const tsconfig = readTsconfig();
  return Object.keys(tsconfig.compilerOptions.paths).filter((key) =>
    key.startsWith(ALIAS_PREFIX),
  );
}

function tsconfigPathTarget(aliasKey: string): string {
  const tsconfig = readTsconfig();
  const [target] = tsconfig.compilerOptions.paths[aliasKey] ?? [];
  if (target === undefined) {
    throw new Error(
      `tsconfig.json#compilerOptions.paths has no entry for ${aliasKey}`,
    );
  }
  return target.replace(/^\.\//, "");
}

type VitestConfigModule = Readonly<{
  default: Readonly<{
    resolve?: Readonly<{ alias?: Readonly<Record<string, string>> }>;
  }>;
}>;

let cachedVitestAlias: Readonly<Record<string, string>> | undefined;

/**
 * Loads `vitest.config.ts#resolve.alias`. The import specifier is assembled
 * at runtime (rather than written as one string literal) so `tsc` never
 * resolves `vitest.config.ts` into this program to type it — that file
 * carries pre-existing, unrelated `noPropertyAccessFromIndexSignature`
 * violations that this batch does not own and must not surface as a
 * regression here (`vitest.config.ts` is on this batch's do-not-touch list).
 */
async function loadVitestAlias(): Promise<Readonly<Record<string, string>>> {
  if (cachedVitestAlias !== undefined) return cachedVitestAlias;
  const specifier = ["..", "vitest.config"].join("/");
  const module = (await import(specifier)) as VitestConfigModule;
  cachedVitestAlias = module.default.resolve?.alias ?? {};
  return cachedVitestAlias;
}

async function readVitestAliasKeys(): Promise<readonly string[]> {
  const alias = await loadVitestAlias();
  return Object.keys(alias).filter((key) => key.startsWith(ALIAS_PREFIX));
}

async function vitestAliasTarget(aliasKey: string): Promise<string> {
  const alias = await loadVitestAlias();
  const target = alias[aliasKey];
  if (target === undefined) {
    throw new Error(
      `vitest.config.ts#resolve.alias has no entry for ${aliasKey}`,
    );
  }
  return path.relative(PACKAGE_ROOT, target).split(path.sep).join("/");
}

/** Recorded at `29d63ec`: `package.json#exports` minus the tsconfig rendering. */
const MISSING_TSCONFIG_PATHS = [
  "./backend",
  "./core",
  "./graph-extension",
  "./adapters/drizzle/indexes",
].toSorted();

/** Recorded at `29d63ec`: those four, plus `./provenance` — vitest is missing one more than tsconfig. */
const MISSING_VITEST_ALIASES = [
  ...MISSING_TSCONFIG_PATHS,
  "./provenance",
].toSorted();

describe("entrypoint rendering parity", () => {
  it("has the recorded key counts: 18 / 14 / 13", async () => {
    expect(readPackageExportKeys().length).toBe(18);
    expect(readTsconfigAliasKeys().length).toBe(14);
    const vitestAliasKeys = await readVitestAliasKeys();
    expect(vitestAliasKeys.length).toBe(13);
  });

  it("tsconfig's missing rows equal the recorded gap, both directions", () => {
    const exportKeys = new Set(readPackageExportKeys());
    const tsconfigExportKeys = new Set(
      readTsconfigAliasKeys().map((key) => toExportKey(key)),
    );

    const missing = [...exportKeys]
      .filter((key) => !tsconfigExportKeys.has(key))
      .toSorted();
    expect(missing).toEqual(MISSING_TSCONFIG_PATHS);

    // Zero extra keys: every tsconfig rendering must name a real entrypoint.
    for (const key of tsconfigExportKeys) {
      expect({ [key]: exportKeys.has(key) }).toEqual({ [key]: true });
    }
  });

  it("vitest's missing rows equal the recorded gap (four, plus ./provenance), both directions", async () => {
    const exportKeys = new Set(readPackageExportKeys());
    const vitestAliasKeys = await readVitestAliasKeys();
    const vitestExportKeys = new Set(
      vitestAliasKeys.map((key) => toExportKey(key)),
    );

    const missing = [...exportKeys]
      .filter((key) => !vitestExportKeys.has(key))
      .toSorted();
    expect(missing).toEqual(MISSING_VITEST_ALIASES);

    for (const key of vitestExportKeys) {
      expect({ [key]: exportKeys.has(key) }).toEqual({ [key]: true });
    }
  });

  it("every present rendering's target equals the reachability scan's derived source root", async () => {
    for (const aliasKey of readTsconfigAliasKeys()) {
      const exportKey = toExportKey(aliasKey);
      expect({ [exportKey]: tsconfigPathTarget(aliasKey) }).toEqual({
        [exportKey]: sourceRootForEntrypoint(exportKey),
      });
    }

    const vitestAliasKeys = await readVitestAliasKeys();
    for (const aliasKey of vitestAliasKeys) {
      const exportKey = toExportKey(aliasKey);
      const target = await vitestAliasTarget(aliasKey);
      expect({ [exportKey]: target }).toEqual({
        [exportKey]: sourceRootForEntrypoint(exportKey),
      });
    }
  });
});
