/**
 * I10 ratchet — the entrypoint list has three hand-maintained renderings
 * (`package.json#exports`, `tsconfig.json#compilerOptions.paths`,
 * `vitest.config.ts#resolve.alias`) with one owner: `exports`. This batch
 * (B4) closed the gap the two other renderings had accumulated (four missing
 * `tsconfig` paths, five missing `vitest` aliases), so every rendering now
 * names all 18 published entrypoints. Both directions stay asserted — a new
 * `exports` key with no matching `tsconfig`/`vitest` entry, or a rendering
 * entry naming a since-removed entrypoint, both fail — and every PRESENT
 * rendering's target is checked against the source root
 * {@link sourceRootForEntrypoint} derives, so a silent divergence between
 * "what tsconfig points at" and "what the tsup entry map says" is caught
 * here too. `loadVitestAlias` still assembles its import specifier at
 * runtime rather than as a literal, and that is unrelated to any
 * do-not-touch list: `vitest.config.ts` carries pre-existing, unrelated
 * `noPropertyAccessFromIndexSignature` violations (bare `process.env.X`
 * access) that this file must not pull into `tsc`'s program, so `tsc` must
 * never statically resolve the import target.
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

describe("entrypoint rendering parity", () => {
  it("tsconfig's paths name exactly the published entrypoints, both directions", () => {
    const exportKeys = new Set(readPackageExportKeys());
    const tsconfigExportKeys = new Set(
      readTsconfigAliasKeys().map((key) => toExportKey(key)),
    );

    expect([...tsconfigExportKeys].toSorted()).toEqual(
      [...exportKeys].toSorted(),
    );
  });

  it("vitest's aliases name exactly the published entrypoints, both directions", async () => {
    const exportKeys = new Set(readPackageExportKeys());
    const vitestAliasKeys = await readVitestAliasKeys();
    const vitestExportKeys = new Set(
      vitestAliasKeys.map((key) => toExportKey(key)),
    );

    expect([...vitestExportKeys].toSorted()).toEqual(
      [...exportKeys].toSorted(),
    );
  });

  it("orders the vitest aliases so no key shadows a longer key", async () => {
    // @rollup/plugin-alias matches `importee === find || importee.startsWith(find
    // + "/")` in INSERTION order, so a shorter key (a prefix of a longer one,
    // notably the bare "@nicia-ai/typegraph") must be inserted AFTER every
    // longer key it would otherwise shadow.
    const alias = await loadVitestAlias();
    const keys = Object.keys(alias);

    for (const [longerIndex, longerKey] of keys.entries()) {
      for (const [shorterIndex, shorterKey] of keys.entries()) {
        if (longerKey === shorterKey) continue;
        if (!longerKey.startsWith(`${shorterKey}/`)) continue;
        expect(
          longerIndex < shorterIndex,
          `${JSON.stringify(longerKey)} (index ${longerIndex}) must be inserted before ${JSON.stringify(shorterKey)} (index ${shorterIndex})`,
        ).toBe(true);
      }
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
