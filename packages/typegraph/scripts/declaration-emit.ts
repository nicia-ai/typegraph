/**
 * The declaration-pipeline facts `scripts/build.ts` runs on.
 *
 * The package's declarations are emitted ONCE by `tsc` into the directory
 * `tsup.config.ts` names, and tsup's declaration rollup then bundles the
 * per-entrypoint `.d.ts` out of that emit instead of re-deriving declarations
 * from source inside the rollup graph. Rolling from source made
 * rollup-plugin-dts build a live TypeScript program and call `program.emit()`
 * once per module, which peaked near 10 GiB of resident memory regardless of
 * which entrypoint was built; the same rollup over an existing `.d.ts` tree
 * needs no program at all — a declarations-only tsup run over the emitted tree
 * measured a 0.46 GiB peak for the whole process, rollup worker included — and
 * emits semantically identical declarations. The one textual difference is
 * member ORDER inside two inferred enum literals on the `interchange`
 * entrypoint, which whole-program emit orders differently from the per-file
 * emit the rollup used to drive.
 *
 * The emit directory and the entry mapping belong to `tsup.config.ts`, which
 * the rollup reads directly; this module resolves them against the package root
 * and adds the facts only the pipeline needs.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DECLARATION_EMIT_DIR as RELATIVE_DECLARATION_EMIT_DIR,
  DECLARATION_ENTRY,
} from "../tsup.config";

export const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** The emit directory `tsup.config.ts` names, resolved for file-system use. */
export const DECLARATION_EMIT_DIR = path.resolve(
  PACKAGE_ROOT,
  RELATIVE_DECLARATION_EMIT_DIR,
);

/**
 * Every declaration file the rollup takes as an entry, resolved for
 * file-system use. A watch session waits for exactly these before starting
 * tsup, so the files it waits on are the files the rollup will open.
 */
export const DECLARATION_ENTRY_FILES: readonly string[] = Object.values(
  DECLARATION_ENTRY,
).map((entryPath) => path.resolve(PACKAGE_ROOT, entryPath));

/** The `tsc` project that emits the declaration tree. */
export const DECLARATION_TSCONFIG = path.join(
  PACKAGE_ROOT,
  "tsconfig.declarations.json",
);

/**
 * The heap ceiling, in MiB, that both stages of the declaration pipeline run
 * under. The pipeline script passes it to the `tsc` and tsup child processes
 * explicitly, so a local `pnpm build` never depends on an ambient
 * `NODE_OPTIONS`; CI's workflow-wide ceiling covers the remaining steps and
 * must not fall below this one.
 */
export const DECLARATION_HEAP_MB = 8192;

/**
 * tsup's declaration CLI flags (`--dts`, `--dts-only`, `--dts-resolve`,
 * `--experimental-dts`) REPLACE the config's `dts` option, which would discard
 * the emitted declaration roots and silently re-root the rollup at `src` — the
 * ~10 GiB path this pipeline exists to avoid, which then dies on the heap
 * ceiling. Refuse them by name instead of forwarding them.
 */
export function assertNoDeclarationOverride(args: readonly string[]): void {
  const DECLARATION_FLAG_PREFIXES = ["--dts", "--experimental-dts"] as const;
  const override = args.find((argument) =>
    DECLARATION_FLAG_PREFIXES.some((prefix) => argument.startsWith(prefix)),
  );
  if (override !== undefined) {
    throw new Error(
      `${override} cannot be passed to the build: it replaces the declaration roots this pipeline emits, re-rooting the declaration rollup at "src". Edit tsup.config.ts's declaration entry instead.`,
    );
  }
}
