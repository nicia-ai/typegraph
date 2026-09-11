/**
 * Pins the two-stage declaration pipeline: `tsc` emits declarations once into
 * `scripts/declaration-emit.ts`'s directory, and tsup's rollup bundles each
 * entrypoint's `.d.ts` out of THAT emit rather than deriving declarations from
 * source inside the rollup graph.
 *
 * The distinction is all but invisible in the published artifacts — the routes
 * differ only in the member order of two inferred enum literals on the
 * `interchange` entrypoint — and visible in build memory: a source-rooted
 * rollup peaked near 10 GiB for every entrypoint, while the two stages
 * together peak near 1.5 GiB. Nothing else would fail if `dts: true` came
 * back, so these assertions are the guard.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertNoDeclarationOverride,
  DECLARATION_EMIT_DIR,
  DECLARATION_ENTRY_FILES,
  DECLARATION_TSCONFIG,
  PACKAGE_ROOT,
} from "../scripts/declaration-emit";
import tsupConfig, { declarationEntryFor } from "../tsup.config";

type EntryMap = Readonly<Record<string, string>>;

const BUILD_PIPELINE_PATH = fileURLToPath(
  new URL("../scripts/build.ts", import.meta.url),
);

function readEntryMaps(): Readonly<{
  entry: EntryMap;
  declarationEntry: EntryMap;
}> {
  expect(Array.isArray(tsupConfig)).toBe(false);
  expect(typeof tsupConfig).toBe("object");

  const config = tsupConfig as Readonly<{
    entry?: unknown;
    dts?: unknown;
  }>;
  const entry = config.entry;
  const dts = config.dts;

  expect(typeof entry).toBe("object");
  // `dts: true` is the regression this file exists to catch: it re-roots the
  // rollup at `src`, which is what cost ~10 GiB.
  expect(typeof dts).toBe("object");

  const declarationEntry = (dts as Readonly<{ entry?: unknown }>).entry;
  expect(typeof declarationEntry).toBe("object");

  return {
    entry: entry as EntryMap,
    declarationEntry: declarationEntry as EntryMap,
  };
}

describe("declaration pipeline", () => {
  it("rolls every published entrypoint out of the emitted declaration tree", () => {
    const { entry, declarationEntry } = readEntryMaps();

    expect(Object.keys(declarationEntry).toSorted()).toEqual(
      Object.keys(entry).toSorted(),
    );

    for (const [name, source] of Object.entries(entry)) {
      const declaration = declarationEntry[name];
      expect(declaration).toBe(declarationEntryFor(source));
      expect(
        path
          .resolve(PACKAGE_ROOT, String(declaration))
          .startsWith(`${DECLARATION_EMIT_DIR}${path.sep}`),
      ).toBe(true);
      expect(declaration?.endsWith(".d.ts")).toBe(true);
    }
  });

  it("waits on exactly the declaration files the rollup opens", () => {
    // A watch session starts tsup once these files exist. Waiting on a
    // narrower list would start the rollup before its inputs are all there;
    // waiting on a wider one would hang a session forever.
    const { declarationEntry } = readEntryMaps();

    expect(DECLARATION_ENTRY_FILES.toSorted()).toEqual(
      Object.values(declarationEntry)
        .map((entry) => path.resolve(PACKAGE_ROOT, entry))
        .toSorted(),
    );
  });

  it("refuses a declaration entry that the emitted tree cannot contain", () => {
    expect(() => declarationEntryFor("scripts/build.ts")).toThrow(
      /does not start with "src\/"/,
    );
    expect(() => declarationEntryFor("src/index.tsx")).toThrow(
      /does not end with "\.ts"/,
    );
  });

  it("refuses a tsup declaration flag that would re-root the rollup at source", () => {
    // These CLI flags replace the config's whole `dts` option, so forwarding
    // one would discard the emitted roots and silently rebuild the ~10 GiB way.
    for (const flag of [
      "--dts",
      "--dts-only",
      "--dts-resolve",
      "--experimental-dts",
    ]) {
      expect(() => {
        assertNoDeclarationOverride(["--silent", flag]);
      }).toThrow(/re-rooting the declaration rollup/);
    }
    // `--no-dts` skips declarations outright rather than re-rooting them, and
    // every unrelated flag is forwarded untouched.
    expect(() => {
      assertNoDeclarationOverride(["--no-dts", "--watch", "--silent"]);
    }).not.toThrow();
  });

  it("emits declarations only, into the pipeline's own disposable directory", () => {
    const declarationTsconfig = JSON.parse(
      readFileSync(DECLARATION_TSCONFIG, "utf8"),
    ) as Readonly<{
      compilerOptions: Readonly<Record<string, unknown>>;
      include: readonly string[];
    }>;

    expect(declarationTsconfig.compilerOptions["emitDeclarationOnly"]).toBe(
      true,
    );
    expect(declarationTsconfig.compilerOptions["declaration"]).toBe(true);
    expect(declarationTsconfig.compilerOptions["declarationMap"]).toBe(false);
    expect(declarationTsconfig.include).toEqual(["src"]);

    // `tsc` reads the emit directory from the tsconfig and the rollup reads it
    // from the seam, so the two spellings must resolve to the same directory —
    // otherwise the rollup bundles a stale tree, or none.
    const configuredOutputDir = declarationTsconfig.compilerOptions["outDir"];
    expect(typeof configuredOutputDir).toBe("string");
    expect(path.resolve(PACKAGE_ROOT, String(configuredOutputDir))).toBe(
      DECLARATION_EMIT_DIR,
    );

    // Not under `node_modules`: rollup-plugin-dts marks every path it
    // resolves there as an external library import, which turns the rolled
    // declarations into bare re-exports of files that do not ship.
    expect(
      path.relative(PACKAGE_ROOT, DECLARATION_EMIT_DIR).split(path.sep),
    ).toEqual([".declaration-emit"]);

    const pipeline = readFileSync(BUILD_PIPELINE_PATH, "utf8");
    expect(pipeline).toContain("DECLARATION_TSCONFIG");
  });
});
