/**
 * The build's command line: the one parser for `scripts/build.ts`'s
 * arguments, and the one place that knows which arguments exist.
 *
 * The build accepts exactly what the repository invokes it with: no argument
 * (`pnpm build`, which turbo, CI and the release workflow run) or `--watch`
 * (`pnpm dev`). It used to forward every other argument to tsup and teach the
 * declaration rollup a few of tsup's spellings, but tsup accepts more
 * spellings than any mirror can track (`--outDir`, `--watch=src`, `--clean`,
 * ...), and an argument one stage understood and the other did not split the
 * build: JavaScript and declarations in different directories, a clean of an
 * output directory nothing validated. Anything else is refused here, before a
 * stage runs, and both stages receive the parsed options rather than argv.
 */

const WATCH_ARGUMENT = "--watch";

/** Every argument the build accepts. */
export const SUPPORTED_BUILD_ARGUMENTS = [WATCH_ARGUMENT] as const;

export type BuildOptions = Readonly<{
  /** Keep every stage running and rebuild on change. */
  watch: boolean;
}>;

/**
 * Parses the build's arguments. Refuses any argument other than a single
 * `--watch`, naming the supported options.
 */
export function parseBuildOptions(args: readonly string[]): BuildOptions {
  if (args.length === 0) return { watch: false };
  if (args.length === 1 && args[0] === WATCH_ARGUMENT) return { watch: true };
  throw new Error(
    `The build does not accept ${args.map((argument) => JSON.stringify(argument)).join(" ")}. Supported: no arguments (pnpm build) or ${WATCH_ARGUMENT} alone (pnpm dev).`,
  );
}
