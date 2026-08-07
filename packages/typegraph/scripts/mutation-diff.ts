import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Computes the Stryker `--mutate` scope for a branch: the line ranges it
 * changed under `packages/typegraph/src`, emitted as
 * `src/<path>.ts:<start>-<end>` entries relative to the package directory
 * (Stryker runs from there).
 *
 * The base ref comes from `MUTATION_BASE_REF` (default `origin/main`) and the
 * diff uses three-dot semantics, so only the branch's own commits count — not
 * whatever landed on the base since it forked.
 *
 * Output modes:
 *
 * - (no flag) one entry per line, for reading
 * - `--csv` entries joined by commas, for `stryker run --mutate "$(...)"`
 * - `--json` a JSON array, for tooling
 *
 * An empty scope is not a failure: `--json` prints `[]`, the other modes print
 * nothing, and every mode exits 0 so callers can skip the mutation run.
 */

type LineRange = Readonly<{ start: number; end: number }>;
type FileScope = Readonly<{ file: string; ranges: readonly LineRange[] }>;
type OutputMode = "csv" | "json" | "lines";

const DEFAULT_BASE_REF = "origin/main";

/**
 * Two changed regions separated by fewer than this many unchanged lines merge
 * into a single entry. Mutating a handful of untouched lines between two edits
 * costs little and keeps the `--mutate` argument short.
 */
const RANGE_MERGE_GAP = 10;

const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

function runGit(repositoryRoot: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function parseOutputMode(args: readonly string[]): OutputMode {
  if (args.length === 0) return "lines";
  if (args.length === 1) {
    if (args[0] === "--json") return "json";
    if (args[0] === "--csv") return "csv";
  }
  throw new Error(
    `Unknown arguments: ${args.join(" ")}. Pass --json, --csv, or nothing.`,
  );
}

function resolveBaseRef(): string {
  const configured = process.env["MUTATION_BASE_REF"];
  if (configured === undefined || configured.trim() === "") {
    return DEFAULT_BASE_REF;
  }
  return configured.trim();
}

function assertBaseRefIsResolvable(repositoryRoot: string, ref: string): void {
  try {
    runGit(repositoryRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ]);
  } catch (error) {
    throw new Error(
      `Base ref "${ref}" is not available locally. Fetch it (git fetch origin) or set MUTATION_BASE_REF.`,
      { cause: error },
    );
  }
}

/**
 * Reads the post-image path out of a `+++ ` diff header. Returns undefined for
 * `/dev/null`, which is how git spells a deleted file — deletions leave no
 * lines to mutate. Renames report their new path here, which is the path
 * Stryker must be given.
 */
function readTargetPath(headerLine: string): string | undefined {
  const target = headerLine.slice("+++ ".length);
  if (target === "/dev/null") return undefined;
  const unquoted =
    target.startsWith('"') && target.endsWith('"') ?
      (JSON.parse(target) as string)
    : target;
  return unquoted.startsWith("b/") ? unquoted.slice(2) : unquoted;
}

function isMutableSourceFile(
  repositoryPath: string,
  sourcePrefix: string,
): boolean {
  if (!repositoryPath.startsWith(sourcePrefix)) return false;
  if (!repositoryPath.endsWith(".ts")) return false;
  return !repositoryPath.endsWith(".d.ts");
}

/**
 * Parses a `--unified=0` diff into the added/modified line ranges per file.
 * `+++` is only honored in a file header (between `diff --git` and the first
 * hunk) so that added source lines beginning with `++ ` cannot be mistaken for
 * one.
 */
function parseChangedRanges(
  diff: string,
  sourcePrefix: string,
): readonly FileScope[] {
  const rangesByFile = new Map<string, LineRange[]>();
  let currentFile: string | undefined;
  let inFileHeader = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      currentFile = undefined;
      inFileHeader = true;
      continue;
    }

    if (inFileHeader && line.startsWith("+++ ")) {
      currentFile = readTargetPath(line);
      continue;
    }

    const hunk = HUNK_HEADER_PATTERN.exec(line);
    if (hunk === null) continue;
    inFileHeader = false;

    if (currentFile === undefined) continue;
    if (!isMutableSourceFile(currentFile, sourcePrefix)) continue;

    const start = Number(hunk[1]);
    // A hunk with a post-image count of 0 removed lines without adding any.
    const addedLineCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (addedLineCount === 0) continue;

    const ranges = rangesByFile.get(currentFile) ?? [];
    ranges.push({ start, end: start + addedLineCount - 1 });
    rangesByFile.set(currentFile, ranges);
  }

  return [...rangesByFile].map(([file, ranges]) => ({
    file,
    ranges: mergeRanges(ranges),
  }));
}

function mergeRanges(ranges: readonly LineRange[]): readonly LineRange[] {
  const sorted = ranges.toSorted((left, right) => left.start - right.start);
  const merged: LineRange[] = [];

  for (const range of sorted) {
    const previous = merged.at(-1);
    if (
      previous === undefined ||
      range.start - previous.end - 1 >= RANGE_MERGE_GAP
    ) {
      merged.push(range);
      continue;
    }
    merged[merged.length - 1] = {
      start: previous.start,
      end: Math.max(previous.end, range.end),
    };
  }

  return merged;
}

function formatEntries(
  scopes: readonly FileScope[],
  packagePrefix: string,
): readonly string[] {
  return scopes.flatMap((scope) => {
    const packageRelativeFile = path.posix.relative(packagePrefix, scope.file);
    return scope.ranges.map(
      (range) => `${packageRelativeFile}:${range.start}-${range.end}`,
    );
  });
}

function printEntries(entries: readonly string[], mode: OutputMode): void {
  switch (mode) {
    case "json": {
      console.log(JSON.stringify(entries));
      return;
    }
    case "csv": {
      if (entries.length > 0) console.log(entries.join(","));
      return;
    }
    case "lines": {
      for (const entry of entries) console.log(entry);
      return;
    }
  }
}

function main(): void {
  const mode = parseOutputMode(process.argv.slice(2));
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const packageDirectory = path.dirname(scriptDirectory);
  const repositoryRoot = runGit(packageDirectory, [
    "rev-parse",
    "--show-toplevel",
  ]).trim();
  const packagePrefix = path
    .relative(repositoryRoot, packageDirectory)
    .replaceAll(path.sep, "/");
  const sourcePrefix = `${packagePrefix}/src/`;
  const baseRef = resolveBaseRef();

  assertBaseRefIsResolvable(repositoryRoot, baseRef);

  const diff = runGit(repositoryRoot, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--unified=0",
    "--no-color",
    "--no-relative",
    `${baseRef}...HEAD`,
    "--",
    `${packagePrefix}/src`,
  ]);

  printEntries(
    formatEntries(parseChangedRanges(diff, sourcePrefix), packagePrefix),
    mode,
  );
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
