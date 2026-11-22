/**
 * The build accepts exactly the arguments the repository invokes it with
 * (`scripts/build-options.ts`), and refuses every other one before a stage
 * runs: tsup and the declaration rollup each understand a different subset
 * of tsup's spellings, so a forwarded argument could split the build or
 * clean a directory nothing validated.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseBuildOptions,
  SUPPORTED_BUILD_ARGUMENTS,
} from "../scripts/build-options";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const BUILD_SCRIPT = "scripts/build.ts";

describe("build options", () => {
  it("accepts a plain build and a watch build", () => {
    expect(parseBuildOptions([])).toEqual({ watch: false });
    expect(parseBuildOptions(["--watch"])).toEqual({ watch: true });
  });

  it("refuses every other argument, naming the supported options", () => {
    for (const args of [
      // Output-directory spellings tsup accepts.
      ["--outDir", "custom"],
      ["--outDir=src"],
      ["--out-dir", "custom"],
      ["--out-dir=custom"],
      ["-d", "custom"],
      // Watch spellings other than the bare flag.
      ["--watch=src"],
      ["--watch", "src"],
      ["--watch", "--watch"],
      ["-w"],
      // Clean overrides.
      ["--clean"],
      ["--no-clean"],
      // Format, declaration and configuration overrides.
      ["--format", "esm"],
      ["--dts"],
      ["--dts-only"],
      ["--no-config"],
      ["--config=other.ts"],
      ["--watch", "--clean"],
      ["src/index.ts"],
    ]) {
      expect(() => parseBuildOptions(args)).toThrow(
        /The build does not accept .*Supported: no arguments \(pnpm build\) or --watch alone \(pnpm dev\)\./,
      );
    }
  });

  it("is invoked by every package script only with supported arguments", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as Readonly<{ scripts: Readonly<Record<string, string>> }>;
    const invocations = Object.entries(manifest.scripts).flatMap(
      ([name, command]) => {
        const at = command.indexOf(BUILD_SCRIPT);
        if (at === -1) return [];
        const rest =
          command.slice(at + BUILD_SCRIPT.length).split(/&&|;|\|/)[0] ?? "";
        return [{ name, args: rest.trim().split(/\s+/).filter(Boolean) }];
      },
    );
    expect(invocations.map((invocation) => invocation.name).toSorted()).toEqual(
      ["build", "dev"],
    );
    for (const { args } of invocations) {
      for (const argument of args) {
        expect(SUPPORTED_BUILD_ARGUMENTS).toContain(argument);
      }
      expect(() => parseBuildOptions(args)).not.toThrow();
    }
  });
});
